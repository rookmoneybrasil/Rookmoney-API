import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'
import { startOfMonth, endOfMonth, subMonths, addDays, subDays, format, addMonths } from 'date-fns'

async function processAutoIncome(uid: string) {
  const now       = new Date()
  const today     = now.getDate()
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const sources   = await db.incomeSource.findMany({ where: { userId: uid, isRecurring: true } })
  for (const src of sources) {
    if (src.lastAutoPayMonth === yearMonth) continue
    if (!src.categoryId) continue
    const day = src.dayOfMonth ?? 1
    if (today < day) continue
    // Don't auto-pay if startDate is in the future
    if (src.startDate && src.startDate > now) continue
    await db.$transaction([
      db.transaction.create({ data: { amount: src.amount, type: 'INCOME', description: src.name, date: new Date(now.getFullYear(), now.getMonth(), day), userId: uid, categoryId: src.categoryId } }),
      db.incomeSource.update({ where: { id: src.id }, data: { lastAutoPayMonth: yearMonth } }),
    ])
  }
}

async function processAutoRecurring(uid: string) {
  const now       = new Date()
  const today     = now.getDate()
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const items     = await db.recurringTransaction.findMany({ where: { userId: uid, isActive: true, frequency: 'MONTHLY' } })
  for (const item of items) {
    if (item.lastAutoMonth === yearMonth) continue
    if (!item.categoryId) continue
    const day = item.dayOfMonth ?? 1
    if (today < day) continue
    await db.$transaction([
      db.transaction.create({ data: { amount: item.amount, type: item.type, description: item.name, date: new Date(now.getFullYear(), now.getMonth(), day), userId: uid, categoryId: item.categoryId } }),
      db.recurringTransaction.update({ where: { id: item.id }, data: { lastAutoMonth: yearMonth } }),
    ])
  }
}

// Data migrations are centralized in api/src/lib/data-migrations.ts

async function processRecurringBills(uid: string) {
  const now       = new Date()
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const y = now.getFullYear(), m = now.getMonth()
  const templates = await db.recurringBill.findMany({
    where: { userId: uid, isActive: true, OR: [{ lastAutoMonth: null }, { lastAutoMonth: { not: yearMonth } }] },
  })
  if (templates.length === 0) return
  for (const t of templates) {
    const day    = Math.min(t.dayOfMonth, new Date(y, m + 1, 0).getDate())
    const dueDate = new Date(Date.UTC(y, m, day, 12, 0, 0))
    const exists  = await db.bill.findFirst({ where: { userId: uid, recurringBillId: t.id, dueDate: { gte: new Date(Date.UTC(y, m, 1)), lte: new Date(Date.UTC(y, m + 1, 0, 23, 59, 59)) } } })
    if (!exists) {
      await db.bill.create({ data: { name: t.name, amount: t.amount, dueDate, isRecurring: false, userId: uid, categoryId: t.categoryId ?? null, notes: t.notes ?? null, recurringBillId: t.id } })
    }
    await db.recurringBill.update({ where: { id: t.id }, data: { lastAutoMonth: yearMonth } })
  }
}

export default withAuth(async (req, res, session) => {
  if (req.method !== 'GET') return res.status(405).end()

  const uid = session.userId
  const now = new Date()

  // Auto-process recurring income, transactions, and bills
  await Promise.allSettled([
    processAutoIncome(uid),
    processAutoRecurring(uid),
    processRecurringBills(uid),
  ])

  const mS  = startOfMonth(now)
  const mE  = endOfMonth(now)
  const pmS = startOfMonth(subMonths(now, 1))
  const pmE = endOfMonth(subMonths(now, 1))
  const yearMonth = format(now, 'yyyy-MM')

  // ── Single Promise.all — all dashboard data in parallel ──────────────────────
  const [
    user,
    income, expense,
    prevIncome, prevExpense,
    recentTx, goals,
    upcomingBills,             // Fix 7: lower bound prevents very old overdue bills
    pendingBillsCount,
    overdueCount,
    peopleEntriesReceivable,
    recurringPeopleReceivable,
    rawPendingIncomeSources,
    incomeThisMonth,
    monthIncomeTx,             // all INCOME transactions this month — for "Receitas do mês" modal
    categoryTx,                // used for donut chart AND overBudgetCount (Fix 3)
    historyTx,
    pendingBillsAgg,
    personPayables,            // Fix 2: all unsettled past+current month
    upcomingPersonPayables,    // current month only — for "A Pagar" modal (consistent with KPI)
    futurePersonPayables,      // 45-day window — for "Compromissos com pessoas" section
    upcomingPeopleReceivable,
    // Fix 1+5: projection data merged into single Promise.all
    recurringIncomeSources,
    recurringTransactionItems,
    pendingPersonEntries,
    recurringBillTemplates,    // Fix 1: RecurringBill templates replace isRecurring bills
    budgets,                   // Fix 3: needed for overBudgetCount
  ] = await Promise.all([
    db.user.findUnique({ where: { id: uid }, select: { name: true } }),

    db.transaction.aggregate({ where: { userId: uid, type: 'INCOME',  date: { gte: mS, lte: mE } }, _sum: { amount: true } }),
    db.transaction.aggregate({ where: { userId: uid, type: 'EXPENSE', date: { gte: mS, lte: mE } }, _sum: { amount: true } }),
    db.transaction.aggregate({ where: { userId: uid, type: 'INCOME',  date: { gte: pmS, lte: pmE } }, _sum: { amount: true } }),
    db.transaction.aggregate({ where: { userId: uid, type: 'EXPENSE', date: { gte: pmS, lte: pmE } }, _sum: { amount: true } }),

    db.transaction.findMany({
      where:   { userId: uid }, orderBy: { date: 'desc' }, take: 7,
      include: { category: { select: { name: true, icon: true, color: true } } },
    }),

    db.goal.findMany({ where: { userId: uid, isCompleted: false }, take: 3, orderBy: { createdAt: 'desc' } }),

    // Fix 7: only bills from last 30 days → 14 days ahead (avoids months-old overdue clutter)
    db.bill.findMany({
      where:   { userId: uid, isPaid: false, dueDate: { gte: subDays(now, 30), lte: addDays(now, 14) } },
      orderBy: { dueDate: 'asc' }, take: 5,
    }),

    db.bill.count({ where: { userId: uid, isPaid: false, dueDate: { gte: mS, lte: mE } } }),
    db.bill.count({ where: { userId: uid, isPaid: false, dueDate: { lt: now } } }),

    // PersonEntry: all unsettled THEY_OWE_ME entries (no date filter — old debts still count)
    db.personEntry.aggregate({ where: { userId: uid, type: 'THEY_OWE_ME', isSettled: false }, _sum: { amount: true } }),
    // PersonEntryRecurring: only templates NOT yet processed this month (avoid double-count with entries above)
    db.personEntryRecurring.aggregate({ where: { userId: uid, isActive: true, type: 'THEY_OWE_ME', OR: [{ lastMonth: null }, { lastMonth: { not: yearMonth } }] }, _sum: { amount: true } }),

    db.incomeSource.findMany({
      where: {
        userId: uid,
        OR: [
          { isRecurring: true,  OR: [{ lastAutoPayMonth: null }, { lastAutoPayMonth: { not: yearMonth } }] },
          { isRecurring: false, lastAutoPayMonth: null },
        ],
      },
      select: { id: true, name: true, amount: true, isRecurring: true, dayOfMonth: true },
      orderBy: { amount: 'desc' },
    }),

    db.transaction.findMany({ where: { userId: uid, type: 'INCOME', date: { gte: mS, lte: mE } }, select: { description: true } }),

    // All INCOME transactions this month (not just the global "recent 7") — Receitas do mês modal
    db.transaction.findMany({
      where:   { userId: uid, type: 'INCOME', date: { gte: mS, lte: mE } },
      orderBy: { date: 'desc' },
      include: { category: { select: { name: true, icon: true, color: true } } },
    }),

    // Fix 3: categoryTx used for donut AND overBudgetCount (no separate query needed)
    // Cannot mix include + select in Prisma — use include only, fields accessed via type cast
    db.transaction.findMany({
      where:   { userId: uid, type: 'EXPENSE', date: { gte: mS, lte: mE } },
      include: { category: { select: { name: true, icon: true, color: true } } },
    }),

    // Monthly history for sparklines (last 6 months)
    db.transaction.findMany({
      where:  { userId: uid, date: { gte: startOfMonth(subMonths(now, 5)), lte: mE } },
      select: { type: true, amount: true, date: true },
    }),

    db.bill.aggregate({ where: { userId: uid, isPaid: false, dueDate: { gte: mS, lte: mE } }, _sum: { amount: true } }),

    // Fix 2: all unsettled person payables up to end of current month (not just this month)
    db.personEntry.aggregate({ where: { userId: uid, type: 'I_OWE_THEM', isSettled: false, date: { lte: mE } }, _sum: { amount: true } }),

    // "A Pagar" modal: only current month + overdue (consistent with the KPI aggregate)
    db.personEntry.findMany({
      where:   { userId: uid, type: 'I_OWE_THEM', isSettled: false, date: { lte: mE } },
      orderBy: { date: 'asc' }, take: 4,
      include: { person: { select: { name: true } } },
    }),

    // "Compromissos com pessoas" section: broader 45-day view (can include next month)
    db.personEntry.findMany({
      where:   { userId: uid, type: 'I_OWE_THEM', isSettled: false, date: { lte: addDays(now, 45) } },
      orderBy: { date: 'asc' }, take: 4,
      include: { person: { select: { name: true } } },
    }),

    db.personEntry.findMany({
      where:   { userId: uid, type: 'THEY_OWE_ME', isSettled: false, date: { lte: addDays(now, 45) } },
      orderBy: { date: 'asc' }, take: 5,
      include: { person: { select: { name: true } } },
    }),

    // Fix 1+5: projection data in main Promise.all — include names for breakdown
    db.incomeSource.findMany({ where: { userId: uid, isRecurring: true }, select: { id: true, name: true, amount: true } }),
    db.recurringTransaction.findMany({ where: { userId: uid, isActive: true, frequency: 'MONTHLY' }, select: { id: true, name: true, amount: true, type: true } }),
    db.personEntry.findMany({
      where:   { userId: uid, type: 'I_OWE_THEM', isSettled: false, installmentGroupId: { not: null } },
      include: { person: { select: { name: true } } },
    }),
    // Fix 1: use RecurringBill templates as monthly fixed expenses (not old isRecurring bills)
    db.recurringBill.findMany({ where: { userId: uid, isActive: true }, select: { id: true, name: true, amount: true } }),

    // Fix 3: budgets for overBudgetCount — merged into main Promise.all
    db.budget.findMany({ where: { userId: uid, month: yearMonth }, select: { categoryId: true, amount: true } }),
  ])

  // ── Derived values ───────────────────────────────────────────────────────────

  // Cross-check pending income sources with actual transactions this month
  const receivedSourceNames = new Set(
    (incomeThisMonth as { description: string | null }[])
      .map(t => t.description)
      .filter((d): d is string => Boolean(d))
  )
  const pendingIncomeSources = (rawPendingIncomeSources as { id: string; name: string; amount: unknown; isRecurring: boolean; dayOfMonth: number | null }[])
    .filter(s => !receivedSourceNames.has(s.name))

  const totalPeopleReceivable = Number(peopleEntriesReceivable._sum.amount ?? 0) + Number(recurringPeopleReceivable._sum.amount ?? 0)
  const totalIncomeReceivable = pendingIncomeSources.reduce((sum: number, src) => sum + Number(src.amount), 0)

  const totalIncome     = Number(income._sum.amount  ?? 0)
  const totalExpense    = Number(expense._sum.amount ?? 0)
  const prevTotalIncome  = Number(prevIncome._sum.amount  ?? 0)
  const prevTotalExpense = Number(prevExpense._sum.amount ?? 0)

  const incomeChange  = prevTotalIncome  > 0 ? Math.round(((totalIncome  - prevTotalIncome)  / prevTotalIncome)  * 100) : 0
  const expenseChange = prevTotalExpense > 0 ? Math.round(((totalExpense - prevTotalExpense) / prevTotalExpense) * 100) : 0

  // Fix 3: overBudgetCount computed from already-fetched data — no extra query
  const overBudgetCount = (budgets as { categoryId: string; amount: unknown }[]).filter(b => {
    const spent = (categoryTx as { categoryId: string; amount: unknown }[])
      .filter(t => t.categoryId === b.categoryId)
      .reduce((s, t) => s + Number(t.amount), 0)
    return spent >= Number(b.amount) * 0.8
  }).length

  // Top categories for donut chart (from categoryTx, already fetched)
  const catMap = new Map<string, { name: string; icon: string; color: string; amount: number }>()
  for (const t of categoryTx as { amount: unknown; category: { name: string; icon: string; color: string } | null }[]) {
    const cat = t.category
    if (!cat) continue
    const cur = catMap.get(cat.name)
    catMap.set(cat.name, { name: cat.name, icon: cat.icon, color: cat.color, amount: (cur?.amount ?? 0) + Number(t.amount) })
  }
  const totalCatExpense = Array.from(catMap.values()).reduce((s, c) => s + c.amount, 0)
  const topCategories   = Array.from(catMap.values())
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)
    .map(c => ({ ...c, pct: totalCatExpense > 0 ? Math.round((c.amount / totalCatExpense) * 100) : 0 }))

  // Monthly history for sparklines
  const monthlyHistory = Array.from({ length: 6 }, (_, i) => {
    const d      = subMonths(now, 5 - i)
    const mStart = startOfMonth(d)
    const mEnd   = endOfMonth(d)
    const txs    = (historyTx as { type: string; amount: unknown; date: unknown }[])
      .filter(t => { const td = new Date(t.date as string); return td >= mStart && td <= mEnd })
    return {
      month:   format(d, 'yyyy-MM'),
      income:  txs.filter(t => t.type === 'INCOME').reduce((s, t) => s + Number(t.amount), 0),
      expense: txs.filter(t => t.type === 'EXPENSE').reduce((s, t) => s + Number(t.amount), 0),
    }
  })

  // ── Projections (5 months ahead) ─────────────────────────────────────────────

  type SrcItem  = { id: string; name: string; amount: unknown }
  type TxItem   = { id: string; name: string; amount: unknown; type: string }
  type PeItem   = { id: string; amount: unknown; date: unknown; description: string; installmentGroupId: string | null; person?: { name: string } }
  type BillItem = { id: string; name: string; amount: unknown }

  const incomeSources = recurringIncomeSources  as SrcItem[]
  const recurringTxs  = recurringTransactionItems as TxItem[]
  const billTpls      = recurringBillTemplates   as BillItem[]
  const personEntries = pendingPersonEntries as PeItem[]

  const recurringIncome  = incomeSources.reduce((s, r) => s + Number(r.amount), 0)
    + recurringTxs.filter(r => r.type === 'INCOME').reduce((s, r) => s + Number(r.amount), 0)

  const recurringExpense = recurringTxs.filter(r => r.type === 'EXPENSE').reduce((s, r) => s + Number(r.amount), 0)
    + billTpls.reduce((s, b) => s + Number(b.amount), 0)

  // Person installment groups — one entry = one monthly obligation
  const personGroupMap = new Map<string, PeItem>()
  for (const e of personEntries) {
    if (e.installmentGroupId && !personGroupMap.has(e.installmentGroupId)) {
      personGroupMap.set(e.installmentGroupId, e)
    }
  }
  const monthlyPersonObligation = Array.from(personGroupMap.values()).reduce((s, e) => s + Number(e.amount), 0)

  const projIncome     = recurringIncome > 0 ? recurringIncome : totalIncome
  const currentBalance = totalIncome - totalExpense

  // Bug 2 fix: use addMonths for correct month arithmetic (avoids skipping Feb)
  // Bug 3 fix: use startOfMonth so month key is always the 1st of the month
  const projected = Array.from({ length: 5 }, (_, i) => {
    const projMonth = addMonths(startOfMonth(now), i + 1)
    const mStart    = startOfMonth(projMonth)
    const mEnd      = endOfMonth(projMonth)

    // Person entries due in this specific projected month
    const personInMonth = personEntries.filter(e => {
      const ed = new Date(e.date as string)
      return ed >= mStart && ed <= mEnd
    })
    const personExpInMonth = personInMonth.reduce((s, e) => s + Number(e.amount), 0)
    const monthPersonExp   = personExpInMonth > 0 ? personExpInMonth : monthlyPersonObligation
    const monthExpense     = recurringExpense + monthPersonExp

    const cumulativeIncome  = projIncome * (i + 1)
    const cumulativeExpense = recurringExpense * (i + 1) + personEntries
      .filter(e => { const ed = new Date(e.date as string); return ed <= mEnd && ed > mS })
      .reduce((s, e) => s + Number(e.amount), 0)

    // Bug 1 fix: populate incomeItems and expenseItems breakdown
    const incomeItems = {
      sources:   incomeSources.map(r => ({ id: r.id, label: r.name, amount: Number(r.amount), icon: '💰' })),
      recurring: recurringTxs.filter(r => r.type === 'INCOME').map(r => ({ id: r.id, label: r.name, amount: Number(r.amount), icon: '↻' })),
      people:    [] as { id: string; label: string; amount: number; icon: string }[],  // person receivables not in scope
    }
    const expenseItems = {
      bills:     billTpls.map(b => ({ id: b.id, label: b.name, amount: Number(b.amount), icon: '📄' })),
      recurring: recurringTxs.filter(r => r.type === 'EXPENSE').map(r => ({ id: r.id, label: r.name, amount: Number(r.amount), icon: '↻' })),
      people:    personInMonth.map(e => ({
        id:     e.id,
        label:  e.person?.name ? `${e.person.name} · ${e.description}` : e.description,
        amount: Number(e.amount),
        icon:   '👤',
      })),
    }

    return {
      month:            mStart.toISOString(),   // always 1st of the month
      projectedIncome:  projIncome,
      projectedExpense: monthExpense,
      projectedBalance: currentBalance + cumulativeIncome - cumulativeExpense,
      incomeItems,
      expenseItems,
    }
  })

  // ── Rookinho insight ──────────────────────────────────────────────────────────
  const daysInMonth = endOfMonth(now).getDate()
  const dayOfMonth  = now.getDate()
  const pacePct     = totalIncome > 0 ? Math.round((totalExpense / totalIncome) * 100) : 0
  const topCat      = topCategories[0]
  const overdueCountNum = Number(overdueCount)

  let insight = ''
  if (overdueCountNum > 0) {
    insight = `Você tem ${overdueCountNum} conta${overdueCountNum > 1 ? 's' : ''} em atraso. Regularize para evitar juros.`
  } else if (totalIncome === 0 && totalExpense === 0) {
    insight = 'Nenhuma movimentação ainda este mês. Registre sua primeira transação!'
  } else if (dayOfMonth <= 10 && pacePct > 60) {
    insight = `Cuidado! Você já gastou ${pacePct}% do que recebeu e o mês ainda está no início.`
  } else if (pacePct > 90) {
    insight = `Você está gastando quase tudo que recebe (${pacePct}%). Que tal revisar o orçamento?`
  } else if (topCat && topCat.pct > 40) {
    insight = `${topCat.icon} ${topCat.name} representa ${topCat.pct}% dos seus gastos este mês.`
  } else if (totalIncome - totalExpense > 0 && dayOfMonth > 20) {
    insight = `Ótimo mês! Você já economizou R$${(totalIncome - totalExpense).toFixed(2).replace('.', ',')} até agora.`
  } else {
    insight = `Você está no dia ${dayOfMonth} de ${daysInMonth}. Continue monitorando seus gastos!`
  }

  return ok(res, {
    userName:              user?.name ?? '',
    monthBalance:          totalIncome - totalExpense,
    monthIncome:           totalIncome,
    monthExpense:          totalExpense,
    incomeChange,
    expenseChange,
    totalPeopleReceivable,
    totalReceivable:       totalPeopleReceivable + totalIncomeReceivable,
    totalIncomeReceivable,
    pendingIncomeSources,
    recentTransactions:    recentTx,
    monthIncomeTransactions: monthIncomeTx,
    goals,
    upcomingBills,
    upcomingPersonPayables,   // current month — A Pagar modal
    futurePersonPayables,     // 45-day — Compromissos section
    upcomingPeopleReceivable,
    pendingBillsCount,
    pendingBillsAmount:    Number(pendingBillsAgg._sum.amount ?? 0),
    personPayablesAmount:  Number(personPayables._sum.amount ?? 0),
    overdueCount:          overdueCountNum,
    overBudgetCount,       // Fix 3: computed inline, no extra query
    projections:           projected,
    monthlyHistory,
    topCategories,
    insight,
    mood: overdueCountNum > 0 ? 'angry' : totalIncome === 0 && totalExpense === 0 ? 'idle' : totalIncome - totalExpense >= 0 ? 'happy' : 'sad',
    // Fix 6: removed unused healthScore (health is computed in page.tsx from the above data)
  })
})
