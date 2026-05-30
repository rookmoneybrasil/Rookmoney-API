import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, created, planLimit } from '@/lib/respond'
import { getLimits } from '@/lib/plans'

export default withAuth(async (req, res, session) => {
  if (req.method === 'GET') {
    const people = await db.person.findMany({
      where:   { userId: session.userId },
      orderBy: { name: 'asc' },
      include: { entries: { where: { isSettled: false }, select: { type: true, amount: true } } },
    })

    // Compute balance per person
    const result = people.map(p => {
      const balance = p.entries.reduce((sum, e) =>
        sum + (e.type === 'THEY_OWE_ME' ? Number(e.amount) : -Number(e.amount)), 0)
      const { entries, ...rest } = p
      return { ...rest, balance, openEntriesCount: entries.length }
    })

    return ok(res, result)
  }

  if (req.method === 'POST') {
    const limits = getLimits(session.plan ?? 'FREE')
    if (limits.people !== null) {
      const count = await db.person.count({ where: { userId: session.userId } })
      if (count >= limits.people) {
        return planLimit(res, `Limite de ${limits.people} pessoas atingido. Faça upgrade para o plano PRO.`)
      }
    }

    const { name, color, notes } = req.body
    const person = await db.person.create({
      data: { name, color: color ?? null, notes: notes ?? null, userId: session.userId },
    })
    return created(res, { ...person, balance: 0, openEntriesCount: 0 })
  }

  return res.status(405).end()
})
