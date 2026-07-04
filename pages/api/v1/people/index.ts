import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, created, planLimit } from '@/lib/respond'
import { getLimits } from '@/lib/plans'
import { checkAchievements } from '@/lib/achievement-checker'
import { processRecurringPersonEntries } from '@/lib/process-recurring-people'

export default withAuth(async (req, res, session) => {
  if (req.method === 'GET') {
    // Best-effort: a transient failure here shouldn't stop the user from
    // seeing their existing data (mirrors the Promise.allSettled tolerance
    // the dashboard's equivalent auto-process calls already have).
    await processRecurringPersonEntries(session.userId).catch(err =>
      console.error('[people] processRecurringPersonEntries failed:', err))

    const now        = new Date()
    const yearMonth  = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)
    // Cutoff only for old-style recurring (installmentTotal >= 24) that haven't been migrated yet
    const cutoff = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000)

    const [people, recurringAll] = await Promise.all([
      db.person.findMany({
        where:   { userId: session.userId },
        orderBy: { name: 'asc' },
        include: {
          entries: {
            select: { type: true, amount: true, date: true, installmentTotal: true, installmentGroupId: true, isSettled: true, recurringEntryId: true },
          },
          _count: { select: { entries: { where: { isSettled: false } } } },
        },
      }),
      db.personEntryRecurring.findMany({
        where:  { userId: session.userId, isActive: true },
        select: { id: true, personId: true, type: true, amount: true, startMonth: true },
      }),
    ])

    const result = people.map(p => {
      let theyOweMe = 0
      let iOweThem  = 0

      for (const e of p.entries) {
        if (e.isSettled) continue // settled entries only used for duplicate detection below
        const isOldRecurring = (e.installmentTotal ?? 0) >= 24
        if (isOldRecurring && new Date(e.date) > cutoff) continue
        if (e.installmentGroupId) {
          // Only count installments due in the current month (mirrors detail page logic)
          const eDate = new Date(e.date)
          if (eDate.getFullYear() !== now.getFullYear() || eDate.getMonth() !== now.getMonth()) continue
        }
        if (e.type === 'THEY_OWE_ME') theyOweMe += Number(e.amount)
        else                           iOweThem  += Number(e.amount)
      }

      // Add recurring templates only when no PersonEntry has been generated for
      // them yet this month (processRecurringPersonEntries above creates one as
      // soon as dayOfMonth passes) — matched via the recurringEntryId FK, not a
      // description/type/date heuristic.
      const personRecurring = recurringAll.filter(r => r.personId === p.id)

      for (const r of personRecurring) {
        // Not started yet (future "1ª data") → don't count until its month.
        if (r.startMonth && yearMonth < r.startMonth) continue
        // Scoped to the current month — otherwise a past (already-settled)
        // entry for this template would match and wrongly suppress this
        // month's not-yet-generated amount.
        const alreadyHasEntry = p.entries.some(e =>
          e.recurringEntryId === r.id &&
          new Date(e.date) >= monthStart && new Date(e.date) <= monthEnd
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
