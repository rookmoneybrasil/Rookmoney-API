import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, created, planLimit } from '@/lib/respond'
import { getLimits } from '@/lib/plans'

export default withAuth(async (req, res, session) => {
  if (req.method === 'GET') {
    // Cutoff only for old-style recurring (installmentTotal >= 24) that haven't been migrated yet
    const cutoff = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000)

    const [people, recurringAll] = await Promise.all([
      db.person.findMany({
        where:   { userId: session.userId },
        orderBy: { name: 'asc' },
        include: {
          entries: {
            where: { isSettled: false },
            select: { type: true, amount: true, date: true, installmentTotal: true, installmentGroupId: true },
          },
          _count: { select: { entries: { where: { isSettled: false } } } },
        },
      }),
      db.personEntryRecurring.findMany({
        where:  { userId: session.userId, isActive: true },
        select: { personId: true, type: true, amount: true },
      }),
    ])

    const result = people.map(p => {
      const groupSeen = new Set<string>()
      let theyOweMe = 0
      let iOweThem  = 0

      for (const e of p.entries) {
        const isOldRecurring = (e.installmentTotal ?? 0) >= 24
        if (isOldRecurring && new Date(e.date) > cutoff) continue
        if (e.installmentGroupId) {
          if (groupSeen.has(e.installmentGroupId)) continue
          groupSeen.add(e.installmentGroupId)
        }
        if (e.type === 'THEY_OWE_ME') theyOweMe += Number(e.amount)
        else                           iOweThem  += Number(e.amount)
      }

      // Include recurring templates
      for (const r of recurringAll.filter(r => r.personId === p.id)) {
        if (r.type === 'THEY_OWE_ME') theyOweMe += Number(r.amount)
        else                           iOweThem  += Number(r.amount)
      }

      const { entries, _count, ...rest } = p
      return {
        ...rest,
        balance:     theyOweMe - iOweThem,
        theyOweMe,
        iOweThem,
        openEntriesCount: _count.entries,
      }
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
