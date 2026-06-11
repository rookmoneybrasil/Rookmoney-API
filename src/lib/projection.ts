import { db } from '@/lib/db'
import { addMonths, format, startOfMonth, endOfMonth, isFuture, isThisMonth } from 'date-fns'
import { ptBR } from 'date-fns/locale'

export type ProjectionItem = {
  id: string; label: string; amount: number; day: number; type: string; href: string
  actual?: boolean; overdue?: boolean
}

export type ProjectionMonthResult = {
  month: string; monthStart: Date; label: string
  incomeItems: ProjectionItem[]; expenseItems: ProjectionItem[]
  totalIncome: number; totalExpense: number
  actualIncome: number; actualExpense: number
  pendingIncome: number; pendingExpense: number
  balance: number; actualBalance: number
  cumulativeBalance: number; actualCumulativeBalance: number
  isActual: boolean
}

// Shared cash-flow projection engine — used by /api/v1/projection (PRO page) and
// /api/v1/dashboard (mini "próximos meses" widget). Keeping this in one place avoids
// the two consumers drifting into different sets of bugs around installments,
// recurrences and person entries.
export async function getProjection(uid: string, months: number): Promise<ProjectionMonthResult[]> {
  const now    = new Date()
  const curMS  = startOfMonth(now)
  const curME  = endOfMonth(now)
  const curKey = format(now, 'yyyy-MM')

  const [
    incomeSources,
    recurringBillTemplates,  // RecurringBill templates, not old isRecurring bills
    recurringTxs,
    personPayables,          // I_OWE_THEM, unsettled, all dates
    personReceivables,       // THEY_OWE_ME, unsettled, all dates
    personRecurringAll,      // PersonEntryRecurring, active, both types
    currentMonthPersonEntries, // settled+unsettled entries in the current month — for recurring dedup
    upcomingBills,
    overdueBills,
    actualTxs,
  ] = await Promise.all([
    db.incomeSource.findMany({
      where:  { userId: uid },
      select: { id: true, name: true, amount: true, dayOfMonth: true, startDate: true, isRecurring: true, lastAutoPayMonth: true },
    }),
    db.recurringBill.findMany({
      where:  { userId: uid, isActive: true },
      select: { id: true, name: true, amount: true, dayOfMonth: true, lastAutoMonth: true },
    }),
    db.recurringTransaction.findMany({
      where:  { userId: uid, isActive: true, frequency: 'MONTHLY' },
      select: { id: true, name: true, amount: true, dayOfMonth: true, type: true, lastAutoMonth: true },
    }),
    db.personEntry.findMany({
      where:   { userId: uid, type: 'I_OWE_THEM', isSettled: false },
      include: { person: { select: { name: true } } },
    }),
    db.personEntry.findMany({
      where:   { userId: uid, type: 'THEY_OWE_ME', isSettled: false },
      include: { person: { select: { name: true } } },
    }),
    db.personEntryRecurring.findMany({
      where:   { userId: uid, isActive: true },
      include: { person: { select: { name: true } } },
    }),
    db.personEntry.findMany({
      where:  { userId: uid, date: { gte: curMS, lte: curME } },
      select: { personId: true, type: true, description: true, installmentGroupId: true },
    }),
    // all unpaid bills due in the projection window
    db.bill.findMany({
      where: {
        userId: uid, isPaid: false,
        dueDate: { gte: curMS, lte: endOfMonth(addMonths(now, months - 1)) },
      },
      select: { id: true, name: true, amount: true, dueDate: true, recurringBillId: true },
    }),
    // overdue bills from prior months (still unpaid) — carried into the current month
    db.bill.findMany({
      where:  { userId: uid, isPaid: false, dueDate: { lt: curMS } },
      select: { id: true, name: true, amount: true, dueDate: true, recurringBillId: true },
    }),
    db.transaction.findMany({
      where: {
        userId: uid,
        date:   { gte: curMS, lte: endOfMonth(addMonths(now, months - 1)) },
      },
      include: { category: { select: { name: true, icon: true } } },
      orderBy: { date: 'asc' },
    }),
  ])

  const allPersonEntries = [...personPayables, ...personReceivables]

  const projection = Array.from({ length: months }, (_, i) => {
    const d      = addMonths(now, i)
    const mS     = startOfMonth(d)
    const mE     = endOfMonth(d)
    const mKey   = format(d, 'yyyy-MM')
    const label  = format(d, 'MMMM yyyy', { locale: ptBR })
    const maxDay = mE.getDate()
    const isPast = !isThisMonth(d) && !isFuture(mS)
    const isCurrent = isThisMonth(d)

    let incomeItems: ProjectionItem[] = []
    let expenseItems: ProjectionItem[] = []

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
        // Pending bills due this month (already fetched in upcomingBills)
        for (const b of upcomingBills) {
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
              overdue: due < now,
            })
          }
        }

        // Overdue bills carried over from prior months (not yet covered above)
        for (const b of overdueBills) {
          expenseItems.push({
            id:      `overdue-bill-${b.id}`,
            label:   b.name,
            amount:  Number(b.amount),
            day:     1,
            type:    'bill',
            href:    '/bills',
            actual:  false,
            overdue: true,
          })
        }

        // Income sources not yet received this month (recurring not auto-paid yet,
        // or eventual sources never received) — mirrors dashboard's pendingIncomeSources
        const receivedSourceNames = new Set(
          monthTxs
            .filter(t => t.type === 'INCOME')
            .map(t => t.description)
            .filter((d): d is string => Boolean(d))
        )
        for (const s of incomeSources) {
          const isPending = s.isRecurring ? s.lastAutoPayMonth !== curKey : s.lastAutoPayMonth === null
          if (!isPending) continue
          if (receivedSourceNames.has(s.name)) continue
          incomeItems.push({
            id:     `pending-income-${s.id}`,
            label:  s.name,
            amount: Number(s.amount),
            day:    Math.min(s.dayOfMonth ?? 1, maxDay),
            type:   'income',
            href:   '/income',
            actual: false,
          })
        }

        // Person payables (I_OWE_THEM) due this month or overdue from prior months
        for (const p of personPayables) {
          const due = new Date(p.date)
          if (due <= mE) {
            expenseItems.push({
              id:      `pending-person-${p.id}`,
              label:   `${p.person.name} · ${p.description}`,
              amount:  Number(p.amount),
              day:     due < mS ? 1 : due.getDate(),
              type:    'person',
              href:    '/people',
              actual:  false,
              overdue: due < mS,
            })
          }
        }

        // Person receivables (THEY_OWE_ME) due this month or overdue from prior months
        for (const p of personReceivables) {
          const due = new Date(p.date)
          if (due <= mE) {
            incomeItems.push({
              id:      `pending-receivable-${p.id}`,
              label:   `${p.person.name} · ${p.description}`,
              amount:  Number(p.amount),
              day:     due < mS ? 1 : due.getDate(),
              type:    'person',
              href:    '/people',
              actual:  false,
              overdue: due < mS,
            })
          }
        }

        // Recurring person entries (PersonEntryRecurring) without an entry this month yet
        for (const r of personRecurringAll) {
          if (r.lastMonth === curKey) continue
          const alreadyHasEntry = currentMonthPersonEntries.some(e =>
            e.personId === r.personId &&
            e.description === r.description &&
            e.type === r.type &&
            !e.installmentGroupId
          )
          if (alreadyHasEntry) continue
          const item: ProjectionItem = {
            id:     `person-recurring-${r.id}`,
            label:  `${r.person.name} · ${r.description}`,
            amount: Number(r.amount),
            day:    Math.min(r.dayOfMonth, maxDay),
            type:   'person',
            href:   '/people',
            actual: false,
          }
          if (r.type === 'THEY_OWE_ME') incomeItems.push(item)
          else                           expenseItems.push(item)
        }

        // RecurringBill templates not yet generated as a Bill for this month.
        // lastAutoMonth === curKey means a Bill was already generated (and possibly
        // already paid or deleted) — only fall back to the unpaid-bill check for the
        // case where /projection is viewed before processRecurringBills runs.
        const generatedRecurringIds = new Set(
          upcomingBills
            .filter(b => b.recurringBillId && new Date(b.dueDate) >= mS && new Date(b.dueDate) <= mE)
            .map(b => b.recurringBillId)
        )
        for (const t of recurringBillTemplates) {
          if (t.lastAutoMonth === curKey) continue
          if (generatedRecurringIds.has(t.id)) continue
          expenseItems.push({
            id:    `rbill-pending-${t.id}-${mKey}`,
            label: t.name,
            amount: Number(t.amount),
            day:   Math.min(t.dayOfMonth, maxDay),
            type:  'bill',
            href:  '/bills',
            actual: false,
          })
        }

        // RecurringTransaction templates not yet auto-processed this month
        for (const r of recurringTxs) {
          if (r.lastAutoMonth === curKey) continue
          const matchType = r.type === 'INCOME' ? 'INCOME' : 'EXPENSE'
          const alreadyIn = monthTxs.some(t => t.type === matchType && (t.description ?? t.category.name) === r.name)
          if (alreadyIn) continue
          const item: ProjectionItem = {
            id:     `rec-pending-${r.id}-${mKey}`,
            label:  r.name,
            amount: Number(r.amount),
            day:    Math.min(r.dayOfMonth ?? 1, maxDay),
            type:   'recurring',
            href:   r.type === 'INCOME' ? '/income' : '/bills',
            actual: false,
          }
          if (r.type === 'INCOME') incomeItems.push(item)
          else                     expenseItems.push(item)
        }
      }
    } else {
      // Future months: pure projection — only include sources active in this month
      incomeItems = incomeSources
        .filter(s => s.isRecurring && (!s.startDate || s.startDate <= mE))
        .map((s) => ({
          id:     `income-${s.id}-${mKey}`,
          label:  s.name,
          amount: Number(s.amount),
          day:    Math.min(s.dayOfMonth ?? 1, maxDay),
          type:   'income',
          href:   '/income',
        }))

      for (const r of recurringTxs.filter(r => r.type === 'INCOME')) {
        incomeItems.push({
          id:     `rec-${r.id}-${mKey}`,
          label:  r.name,
          amount: Number(r.amount),
          day:    Math.min(r.dayOfMonth ?? 1, maxDay),
          type:   'recurring',
          href:   '/income',
        })
      }

      // RecurringBill templates fill in months where no Bill instance has been generated yet
      // (upcomingBills already covers generated instances — avoid duplicates)
      const upcomingRecurringIds = new Set(
        upcomingBills
          .filter(b => b.recurringBillId && new Date(b.dueDate) >= mS && new Date(b.dueDate) <= mE)
          .map(b => b.recurringBillId)
      )
      for (const t of recurringBillTemplates) {
        if (upcomingRecurringIds.has(t.id)) continue
        expenseItems.push({
          id:    `rbill-${t.id}-${mKey}`,
          label: t.name,
          amount: Number(t.amount),
          day:   Math.min(t.dayOfMonth, maxDay),
          type:  'bill',
          href:  '/bills',
        })
      }

      for (const r of recurringTxs.filter(r => r.type === 'EXPENSE')) {
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

      // Person payables (I_OWE_THEM) — installments and one-off debts due in this month
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

      // Person receivables (THEY_OWE_ME) — installments and one-off credits due in this month
      for (const p of personReceivables) {
        const due = new Date(p.date)
        if (due >= mS && due <= mE) {
          incomeItems.push({
            id:     `person-${p.id}`,
            label:  `${p.person.name} · ${p.description}`,
            amount: Number(p.amount),
            day:    due.getDate(),
            type:   'person',
            href:   '/people',
          })
        }
      }

      // Recurring person entries (PersonEntryRecurring) projected for future months
      for (const r of personRecurringAll) {
        const alreadyHasEntry = allPersonEntries.some(e => {
          const ed = new Date(e.date)
          return e.personId === r.personId &&
            e.description === r.description &&
            e.type === r.type &&
            !e.installmentGroupId &&
            ed >= mS && ed <= mE
        })
        if (alreadyHasEntry) continue
        const item: ProjectionItem = {
          id:     `person-recurring-${r.id}-${mKey}`,
          label:  `${r.person.name} · ${r.description}`,
          amount: Number(r.amount),
          day:    Math.min(r.dayOfMonth, maxDay),
          type:   'person',
          href:   '/people',
        }
        if (r.type === 'THEY_OWE_ME') incomeItems.push(item)
        else                           expenseItems.push(item)
      }
    }

    incomeItems.sort((a, b) => a.day - b.day)
    expenseItems.sort((a, b) => a.day - b.day)

    const totalIncome  = incomeItems.reduce((s, e) => s + e.amount, 0)
    const totalExpense = expenseItems.reduce((s, e) => s + e.amount, 0)

    // For past/current months, split into amounts already confirmed (actual transactions)
    // vs amounts still pending (bills not yet paid, income not yet received, etc).
    // Future months are pure estimates — nothing has happened yet.
    const isPastOrCurrent = isPast || isCurrent
    const pendingIncome  = isPastOrCurrent ? incomeItems.filter(i => i.actual === false).reduce((s, e) => s + e.amount, 0)  : totalIncome
    const pendingExpense = isPastOrCurrent ? expenseItems.filter(i => i.actual === false).reduce((s, e) => s + e.amount, 0) : totalExpense
    const actualIncome   = totalIncome  - pendingIncome
    const actualExpense  = totalExpense - pendingExpense

    return {
      month: mKey, monthStart: mS, label,
      incomeItems, expenseItems,
      totalIncome, totalExpense,
      actualIncome, actualExpense, pendingIncome, pendingExpense,
      balance: totalIncome - totalExpense,
      actualBalance: actualIncome - actualExpense,
      isActual: isPastOrCurrent,
    }
  })

  let cumulative = 0
  let actualCumulative = 0
  return projection.map((m) => {
    cumulative += m.balance
    actualCumulative += m.actualBalance
    return { ...m, cumulativeBalance: cumulative, actualCumulativeBalance: actualCumulative }
  })
}
