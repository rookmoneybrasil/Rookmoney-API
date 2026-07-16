import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, created, planLimit } from '@/lib/respond'
import { getLimits } from '@/lib/plans'
import { checkAchievements } from '@/lib/achievement-checker'
import { computePersonBalances } from '@/lib/person-balances'

export default withAuth(async (req, res, session) => {
  if (req.method === 'GET') {
    // A conta de saldo por pessoa vive em src/lib/person-balances.ts — o menu do
    // WhatsApp consome a MESMA funcao. Nao reimplemente aqui: a regra e sutil e
    // duplicar faz o numero do app divergir do WhatsApp (ver CLAUDE.md).
    return ok(res, await computePersonBalances(session.userId))
  }

  if (req.method === 'POST') {
    const { name, color, notes } = req.body

    const limits = getLimits(session.plan ?? 'FREE')
    if (limits.people !== null) {
      const allowed = await db.$transaction(async (tx) => {
        const count = await tx.person.count({ where: { userId: session.userId } })
        return count < limits.people!
      })
      if (!allowed) return planLimit(res, `Limite de ${limits.people} pessoas atingido. Faça upgrade para o plano PRO.`)
    }

    const person = await db.person.create({
      data: { name, color: color ?? null, notes: notes ?? null, userId: session.userId },
    })
    checkAchievements(db, session.userId, 'create-person').catch(() => {})
    return created(res, { ...person, balance: 0, openEntriesCount: 0 })
  }

  return res.status(405).end()
})
