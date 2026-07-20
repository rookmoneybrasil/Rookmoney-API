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

    // Plan limit — counts only ACTIVE (non-archived) accounts.
    const limits = getLimits(session.plan ?? 'FREE')
    if (limits.accounts !== null) {
      const allowed = await db.$transaction(async (tx) => {
        const count = await tx.account.count({ where: { userId: session.userId, archived: false } })
        return count < limits.accounts!
      })
      if (!allowed) return planLimit(res, `Limite de ${limits.accounts} contas atingido. Faça upgrade para o plano PRO.`)
    }

    // First account a user creates becomes the default.
    const hasDefault = await db.account.findFirst({ where: { userId: session.userId, isDefault: true }, select: { id: true } })

    const account = await db.account.create({
      data: {
        userId:         session.userId,
        name:           name.trim(),
        type:           accType as typeof TYPES[number],
        icon:           icon || '💳',
        color:          color || '#3B82F6',
        initialBalance: initialBalance != null ? Number(initialBalance) : 0,
        isDefault:      !hasDefault,
      },
    })
    return created(res, account)
  }

  return res.status(405).end()
})
