import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, created, badRequest, planLimit } from '@/lib/respond'
import { getLimits } from '@/lib/plans'
import { computeAccountBalances, sumActiveBalances } from '@/lib/account-balances'

const TYPES = ['CASH', 'CHECKING', 'SAVINGS', 'CREDIT_CARD'] as const

export default withAuth(async (req, res, session) => {
  if (req.method === 'GET') {
    const accounts = await computeAccountBalances(session.userId)
    const total = sumActiveBalances(accounts)
    return ok(res, { accounts, total })
  }

  if (req.method === 'POST') {
    const { name, type, icon, color, initialBalance } = req.body as {
      name?: string; type?: string; icon?: string; color?: string; initialBalance?: number | string
    }
    if (!name || !name.trim()) return badRequest(res, 'Nome é obrigatório.')
    const accType = TYPES.includes(type as typeof TYPES[number]) ? type : 'CASH'

    // Um NaN aqui envenenaria o saldo pra sempre: o total e' uma soma, e
    // qualquer NaN no meio torna o saldo total inteiro NaN ("R$ NaN" na tela).
    const initial = initialBalance != null ? Number(initialBalance) : 0
    if (!Number.isFinite(initial)) return badRequest(res, 'Saldo inicial inválido.')

    // Plan limit — counts only ACTIVE (non-archived) accounts. O count E o create
    // precisam estar DENTRO da mesma transacao: com o create fora, dois requests
    // concorrentes contam 1 os dois, ambos passam e o FREE termina com 3 contas.
    const limits = getLimits(session.plan ?? 'FREE')
    const account = await db.$transaction(async (tx) => {
      if (limits.accounts !== null) {
        const count = await tx.account.count({ where: { userId: session.userId, archived: false } })
        if (count >= limits.accounts) return null
      }
      // First account a user creates becomes the default.
      const hasDefault = await tx.account.findFirst({ where: { userId: session.userId, isDefault: true }, select: { id: true } })
      return tx.account.create({
        data: {
          userId:         session.userId,
          name:           name.trim(),
          type:           accType as typeof TYPES[number],
          icon:           icon || '💳',
          color:          color || '#3B82F6',
          initialBalance: initial,
          isDefault:      !hasDefault,
        },
      })
    })
    if (!account) return planLimit(res, `Limite de ${limits.accounts} contas atingido. Faça upgrade para o plano PRO.`)
    return created(res, account)
  }

  return res.status(405).end()
})
