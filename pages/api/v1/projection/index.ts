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
    recurringBills,
    recurringTxs,
    personPayables,
    upcomingBills,
    overdueBills,
    actualTxs,
  ] = await Promise.all([
    db.incomeSource.findMany({
      where:  { userId: uid, isRecurring: true },
      select: { id: true, name: true, amount: true, dayOfMonth: true, type: true },
    }),
    db.bill.findMany({
      where:  { userId: uid, isPaid: false, isRecurring: true },
      select: { id: true, name: true, amount: true, dueDate: true },
    }),
    db.recurringTransaction.findMany({
      where:  { userId: uid, isActive: true, frequency: 'MONTHLY', type: 'EXPENSE' },
      select: { id: true, name: true, amount: true, dayOfMonth: true },
    }),
    db.personEntry.findMany({
      where:   { userId: uid, type: 'I_OWE_THEM', isSettled: false },
      include: { person: { select: { name: true } } },
    }),
    db.bill.findMany({
      where: {
        userId: uid, isPaid: false, isRecurring: false,
        dueDate: { gte: startOfMonth(now), lte: endOfMonth(addMonths(now, months - 1)) },
      },
      select: { id: true, name: true, amount: true, dueDate: true },
    }),
    // Overdue bills (dueDate before today, still unpaid)
    db.bill.findMany({
      where: { userId: uid, isPaid: false, dueDate: { lt: now } },
      select: { id: true, name: true, amount: true, dueDate: true, isRecurring: true },
    }),
    // Actual transactions for current + past months in the range
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
        // Pending bills
        for (const b of [...upcomingBills, ...recurringBills]) {
          const due = new Date(b.dueDate)
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
      // Future months: pure projection
      incomeItems = incomeSources.map((s) => ({
        id:     `income-${s.id}-${mKey}`,
        label:  s.name,
        amount: Number(s.amount),
        day:    Math.min(s.dayOfMonth ?? 1, maxDay),
        type:   'income',
        href:   '/income',
      }))

      for (const b of recurringBills) {
        const dueDay    = new Date(b.dueDate).getDate()
        const isOverdue = new Date(b.dueDate) < now

        if (isOverdue) {
          // 1. The unpaid overdue entry (outstanding debt from past month)
          expenseItems.push({
            id:      `rbill-overdue-${b.id}-${mKey}`,
            label:   b.name,
            amount:  Number(b.amount),
            day:     Math.min(dueDay, maxDay),
            type:    'bill',
            href:    '/bills',
            overdue: true,
          })
          // 2. The new projected occurrence for this month
          expenseItems.push({
            id:     `rbill-new-${b.id}-${mKey}`,
            label:  b.name,
            amount: Number(b.amount),
            day:    Math.min(dueDay, maxDay),
            type:   'bill',
            href:   '/bills',
          })
        } else {
          expenseItems.push({
            id:     `rbill-${b.id}-${mKey}`,
            label:  b.name,
            amount: Number(b.amount),
            day:    Math.min(dueDay, maxDay),
            type:   'bill',
            href:   '/bills',
          })
        }
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

      // Non-recurring overdue bills — show in ALL future months until paid
      // (recurring overdue ones are already in recurringBills above with overdue:true)
      for (const b of overdueBills) {
        if (!b.isRecurring) {
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
