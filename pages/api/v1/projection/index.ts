import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, planRequired } from '@/lib/respond'
import { addMonths, format, startOfMonth, endOfMonth, isFuture, isThisMonth } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { getLimits } from '@/lib/plans'

export default withAuth(async (req, res, session) => {
  if (req.method !== 'GET') return res.status(405).end()
  const limits = getLimits(session.plan ?? 'FREE')
  if (!limits.projection) return planRequired(res, 'Projeção financeira')

  const uid    = session.userId
  const months = Math.min(Number(req.query.months ?? 6), 12)
  const now    = new Date()

  const [
    incomeSources,
    recurringBillTemplates,  // Bug 1 fix: RecurringBill templates, not old isRecurring bills
    recurringTxs,
    personPayables,
    upcomingBills,
    overdueBills,
    actualTxs,
  ] = await Promise.all([
    db.incomeSource.findMany({
      where:  { userId: uid, isRecurring: true },
      select: { id: true, name: true, amount: true, dayOfMonth: true, type: true, startDate: true },
    }),
    // Bug 1 fix: use RecurringBill templates (isRecurring flag retired after migration)
    db.recurringBill.findMany({
      where:  { userId: uid, isActive: true },
      select: { id: true, name: true, amount: true, dayOfMonth: true },
    }),
    db.recurringTransaction.findMany({
      where:  { userId: uid, isActive: true, frequency: 'MONTHLY', type: 'EXPENSE' },
      select: { id: true, name: true, amount: true, dayOfMonth: true },
    }),
    db.personEntry.findMany({
      where:   { userId: uid, type: 'I_OWE_THEM', isSettled: false },
      include: { person: { select: { name: true } } },
    }),
    // Bug 2 fix: all unpaid bills — isRecurring is now always false after migration
    db.bill.findMany({
      where: {
        userId: uid, isPaid: false,
        dueDate: { gte: startOfMonth(now), lte: endOfMonth(addMonths(now, months - 1)) },
      },
      select: { id: true, name: true, amount: true, dueDate: true, recurringBillId: true },
    }),
    db.bill.findMany({
      where:  { userId: uid, isPaid: false, dueDate: { lt: now } },
      select: { id: true, name: true, amount: true, dueDate: true, recurringBillId: true },
    }),
    db.transaction.findMany({
      where: {
        userId: uid,
        date:   { gte: startOfMonth(now), lte: endOfMonth(addMonths(now, months - 1)) },
      },
      include: { category: { select: { name: true, icon: true } } },
      orderBy: { date: 'asc' },
    }),
  ])

  const projection = Array.from({ length: months }, (_, i) => {
    const d      = addMonths(now, i)
    const mS     = startOfMonth(d)
    const mE     = endOfMonth(d)
    const mKey   = format(d, 'yyyy-MM')
    const label  = format(d, 'MMMM yyyy', { locale: ptBR })
    const maxDay = mE.getDate()
    const isPast = !isThisMonth(d) && !isFuture(mS)
    const isCurrent = isThisMonth(d)

    let incomeItems: { id: string; label: string; amount: number; day: number; type: string; href: string; actual?: boolean; overdue?: boolean }[] = []
    let expenseItems: { id: string; label: string; amount: number; day: number; type: string; href: string; actual?: boolean; overdue?: boolean }[] = []

    if (isPast || isCurrent) {
      // Use actual transactions for current and past months
      const monthTxs = actualTxs.filter(t => {
        const td = new Date(t.date)
        return td >= mS && td <= mE
      })

      incomeItems = monthTxs
        .filter(t => t.type === 'INCOME')
        .map(t => ({
          id:     t.id,
          label:  t.description ?? t.category.name,
          amount: Number(t.amount),
          day:    new Date(t.date).getDate(),
          type:   'income',
          href:   '/transactions',
          actual: true,
        }))

      expenseItems = monthTxs
        .filter(t => t.type === 'EXPENSE')
        .map(t => ({
          id:     t.id,
          label:  t.description ?? t.category.name,
          amount: Number(t.amount),
          day:    new Date(t.date).getDate(),
          type:   'bill',
          href:   '/transactions',
          actual: true,
        }))

      // For current month: also add PENDING items (not yet paid/received)
      if (isCurrent) {
        // Pending bills (all unpaid bills for this month, already fetched in upcomingBills)
        for (const b of upcomingBills) {
          const due = new Date((b as { dueDate: unknown }).dueDate as string)
          if (due >= mS && due <= mE) {
            expenseItems.push({
              id:    `pending-bill-${b.id}`,
              label: b.name,
              amount: Number(b.amount),
              day:   due.getDate(),
              type:  'bill',
              href:  '/bills',
              actual: false,
            })
          }
        }

        // Income sources not yet received this month
        for (const s of incomeSources) {
          const day = Math.min(s.dayOfMonth ?? 1, maxDay)
          const alreadyIn = incomeItems.some(it => it.label === s.name && it.actual)
          if (!alreadyIn && day > now.getDate()) {
            incomeItems.push({
              id:     `pending-income-${s.id}`,
              label:  s.name,
              amount: Number(s.amount),
              day,
              type:   'income',
              href:   '/income',
              actual: false,
            })
          }
        }

        // Pending person payables
        for (const p of personPayables) {
          const due = new Date(p.date)
          if (due >= mS && due <= mE && due > now) {
            expenseItems.push({
              id:    `pending-person-${p.id}`,
              label: `${p.person.name} · ${p.description}`,
              amount: Number(p.amount),
              day:   due.getDate(),
              type:  'person',
              href:  '/people',
              actual: false,
            })
          }
        }
      }
    } else {
      // Future months: pure projection — only include sources active in this month
      incomeItems = incomeSources
        .filter(s => !s.startDate || s.startDate <= mE)
        .map((s) => ({
          id:     `income-${s.id}-${mKey}`,
          label:  s.name,
          amount: Number(s.amount),
          day:    Math.min(s.dayOfMonth ?? 1, maxDay),
          type:   'income',
          href:   '/income',
        }))

      // Bug 1+2 fix: use RecurringBill templates for future months.
      // upcomingBills already covers generated instances; templates fill in
      // months where no bill has been generated yet (avoiding duplicates via
      // the upcomingBills check above).
      const upcomingRecurringIds = new Set(
        upcomingBills
          .filter(b => b.recurringBillId && new Date((b as { dueDate: unknown }).dueDate as string) >= mS && new Date((b as { dueDate: unknown }).dueDate as string) <= mE)
          .map(b => b.recurringBillId)
      )
      for (const t of recurringBillTemplates) {
        if (upcomingRecurringIds.has(t.id)) continue  // already in upcomingBills for this month
        expenseItems.push({
          id:    `rbill-${t.id}-${mKey}`,
          label: t.name,
          amount: Number(t.amount),
          day:   Math.min(t.dayOfMonth, maxDay),
          type:  'bill',
          href:  '/bills',
        })
      }

      for (const r of recurringTxs) {
        expenseItems.push({
          id:     `rec-${r.id}-${mKey}`,
          label:  r.name,
          amount: Number(r.amount),
          day:    Math.min(r.dayOfMonth ?? 1, maxDay),
          type:   'recurring',
          href:   '/bills',
        })
      }

      for (const b of upcomingBills) {
        const due = new Date(b.dueDate)
        if (due >= mS && due <= mE) {
          expenseItems.push({
            id:      `bill-${b.id}`,
            label:   b.name,
            amount:  Number(b.amount),
            day:     due.getDate(),
            type:    'bill',
            href:    '/bills',
            overdue: due < now,
          })
        }
      }

      // Overdue bills not covered by templates — show in ALL future months until paid
      for (const b of overdueBills) {
        if (!b.recurringBillId) {  // template-based overdue bills already handled above
          expenseItems.push({
            id:      `overdue-${b.id}-${mKey}`,
            label:   b.name,
            amount:  Number(b.amount),
            day:     1,
            type:    'bill',
            href:    '/bills',
            overdue: true,
          })
        }
      }
      // Also mark current-month non-recurring bills as overdue if dueDate already passed
      // (they're in upcomingBills which filters gte:startOfMonth — may already be overdue)


      for (const p of personPayables) {
        const due = new Date(p.date)
        if (due >= mS && due <= mE) {
          expenseItems.push({
            id:     `person-${p.id}`,
            label:  `${p.person.name} · ${p.description}`,
            amount: Number(p.amount),
            day:    due.getDate(),
            type:   'person',
            href:   '/people',
          })
        }
      }
    }

    incomeItems.sort((a, b) => a.day - b.day)
    expenseItems.sort((a, b) => a.day - b.day)

    const totalIncome  = incomeItems.reduce((s, e) => s + e.amount, 0)
    const totalExpense = expenseItems.reduce((s, e) => s + e.amount, 0)

    return {
      month: mKey, label,
      incomeItems, expenseItems,
      totalIncome, totalExpense,
      balance: totalIncome - totalExpense,
      isActual: isPast || isCurrent,
    }
  })

  let cumulative = 0
  const result = projection.map((m) => {
    cumulative += m.balance
    return { ...m, cumulativeBalance: cumulative }
  })

  return ok(res, result)
})
