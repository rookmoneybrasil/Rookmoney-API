import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, created, planLimit } from '@/lib/respond'
import { getLimits } from '@/lib/plans'
import { checkAchievements } from '@/lib/achievement-checker'

export default withAuth(async (req, res, session) => {
  if (req.method === 'GET') {
    const now      = new Date()
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    // Cutoff only for old-style recurring (installmentTotal >= 24) that haven't been migrated yet
    const cutoff = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000)

    const [people, recurringAll] = await Promise.all([
      db.person.findMany({
        where:   { userId: session.userId },
        orderBy: { name: 'asc' },
        include: {
          entries: {
            // Include current-month entries (settled or not) to detect recurring duplicates
            // Balance loop below only sums unsettled; settled ones are used only for duplicate detection
            select: { type: true, amount: true, date: true, installmentTotal: true, installmentGroupId: true, isSettled: true, description: true },
          },
          _count: { select: { entries: { where: { isSettled: false } } } },
        },
      }),
      db.personEntryRecurring.findMany({
        where:  { userId: session.userId, isActive: true },
        select: { personId: true, type: true, amount: true, description: true, lastMonth: true },
      }),
    ])

    const result = people.map(p => {
      const groupSeen = new Set<string>()
      let theyOweMe = 0
      let iOweThem  = 0

      for (const e of p.entries) {
        if (e.isSettled) continue // settled entries only used for duplicate detection below
        const isOldRecurring = (e.installmentTotal ?? 0) >= 24
        if (isOldRecurring && new Date(e.date) > cutoff) continue
        if (e.installmentGroupId) {
          if (groupSeen.has(e.installmentGroupId)) continue
          groupSeen.add(e.installmentGroupId)
        }
        if (e.type === 'THEY_OWE_ME') theyOweMe += Number(e.amount)
        else                           iOweThem  += Number(e.amount)
      }

      // Add recurring templates only when no PersonEntry already exists for them this month
      // Use description+type match (same as detail page) — lastMonth alone misses manually-created entries
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
      const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)
      const personRecurring = recurringAll.filter(r => r.personId === p.id)

      for (const r of personRecurring) {
        const alreadyHasEntry = p.entries.some(e =>
          e.description === r.description &&
          e.type        === r.type &&
          !e.installmentGroupId &&
          new Date(e.date) >= monthStart &&
          new Date(e.date) <= monthEnd
        )
        if (alreadyHasEntry) continue // entry already counted above
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
