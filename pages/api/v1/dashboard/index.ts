import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'
import { startOfMonth, endOfMonth, subMonths, addDays, subDays, format } from 'date-fns'
import { getProjection, type ProjectionItem } from '@/lib/projection'
import { autoProcessMonth } from '@/lib/auto-process'
import { computeAccountBalances, sumActiveBalances } from '@/lib/account-balances'

// Data migrations are centralized in api/src/lib/data-migrations.ts
// O auto-process vive em api/src/lib/auto-process.ts — o get_summary do Rookinho
// e o menu do WhatsApp chamam a MESMA funcao, senao leem saldo defasado.

export default withAuth(async (req, res, session) => {
  if (req.method !== 'GET') return res.status(405).end()

  const uid = session.userId
  const now = new Date()

  await autoProcessMonth(uid)

  const mS  = startOfMonth(now)
  const mE  = endOfMonth(now)
  const pmS = startOfMonth(subMonths(now, 1))
  const pmE = endOfMonth(subMonths(now, 1))
  const yearMonth = format(now, 'yyyy-MM')

  // ── Single Promise.all — all dashboard data in parallel ──────────────────────
  const [[
    user,
    income, expense,
    prevIncome, prevExpense,
    recentTx, goals,
    upcomingBills,             // Fix 7: lower bound prevents very old overdue bills
    pendingBillsCount,
    overdueCount,
    peopleEntriesReceivable,
    allRecurringTemplates,
    rawPendingIncomeSources,
    incomeThisMonth,
    monthIncomeTx,             // all INCOME transactions this month — for "Receitas do mês" modal
    monthPeopleReceivedRaw,    // settled THEY_OWE_ME entries this month — for "Receitas do mês" modal
    categoryTx,                // used for donut chart AND overBudgetCount (Fix 3)
    historyTx,
    pendingBillsAgg,
    personPayables,            // Fix 2: all unsettled past+current month
    upcomingPersonPayables,    // current month only — for "A Pagar" modal (consistent with KPI)
    futurePersonPayables,      // 45-day window — for "Compromissos com pessoas" section
    upcomingPeopleReceivable,
    // Used to classify month income transactions as fixed/recurring vs avulso (name-matching)
    recurringIncomeSources,
    recurringTransactionItems,
    budgets,                   // Fix 3: needed for overBudgetCount
    currentMonthPersonEntries, // for recurring duplicate detection (description-match)
  ], projResult] = await Promise.all([
    Promise.all([
    db.user.findUnique({ where: { id: uid }, select: { name: true } }),

    db.transaction.aggregate({ where: { userId: uid, type: 'INCOME',  date: { gte: mS, lte: mE }, ignored: false }, _sum: { amount: true } }),
    db.transaction.aggregate({ where: { userId: uid, type: 'EXPENSE', date: { gte: mS, lte: mE }, ignored: false }, _sum: { amount: true } }),
    db.transaction.aggregate({ where: { userId: uid, type: 'INCOME',  date: { gte: pmS, lte: pmE }, ignored: false }, _sum: { amount: true } }),
    db.transaction.aggregate({ where: { userId: uid, type: 'EXPENSE', date: { gte: pmS, lte: pmE }, ignored: false }, _sum: { amount: true } }),

    db.transaction.findMany({
      where:   { userId: uid }, orderBy: { date: 'desc' }, take: 7,
      include: {
        category: { select: { name: true, icon: true, color: true } },
        account:  { select: { name: true, icon: true, color: true } },
      },
    }),

    db.goal.findMany({ where: { userId: uid, isCompleted: false }, take: 3, orderBy: { createdAt: 'desc' } }),

    // Fix 7: only bills from last 30 days → 14 days ahead (avoids months-old overdue clutter)
    db.bill.findMany({
      where:   { userId: uid, isPaid: false, dueDate: { gte: subDays(now, 30), lte: addDays(now, 14) } },
      orderBy: { dueDate: 'asc' }, take: 5,
    }),

    db.bill.count({ where: { userId: uid, isPaid: false, dueDate: { lte: mE } } }),
    db.bill.count({ where: { userId: uid, isPaid: false, dueDate: { lt: now } } }),

    // PersonEntry: all unsettled THEY_OWE_ME entries (no date filter — old debts still count)
    db.personEntry.aggregate({ where: { userId: uid, type: 'THEY_OWE_ME', isSettled: false }, _sum: { amount: true } }),
    // All active recurring person templates — computed in JS using description-match (same as /api/v1/people)
    db.personEntryRecurring.findMany({ where: { userId: uid, isActive: true }, include: { person: { select: { name: true } } } }),

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

    // All INCOME transactions this month (not just the global "recent 7") — Receitas do mês modal.
    // Precisa do MESMO ignored:false do KPI acima, senao o modal soma mais que o card.
    db.transaction.findMany({
      where:   { userId: uid, type: 'INCOME', date: { gte: mS, lte: mE }, ignored: false },
      orderBy: { date: 'desc' },
      include: { category: { select: { name: true, icon: true, color: true } } },
    }),

    // Settled "they owe me" entries resolved this month — Receitas do mês modal (Pessoas)
    db.personEntry.findMany({
      where:   { userId: uid, type: 'THEY_OWE_ME', isSettled: true, settledAt: { gte: mS, lte: mE } },
      orderBy: { settledAt: 'desc' },
      include: { person: { select: { name: true } } },
    }),

    // Fix 3: categoryTx used for donut AND overBudgetCount (no separate query needed)
    // Cannot mix include + select in Prisma — use include only, fields accessed via type cast
    db.transaction.findMany({
      where:   { userId: uid, type: 'EXPENSE', date: { gte: mS, lte: mE }, ignored: false },
      include: { category: { select: { name: true, icon: true, color: true } } },
    }),

    // Monthly history for sparklines (last 6 months)
    db.transaction.findMany({
      where:  { userId: uid, date: { gte: startOfMonth(subMonths(now, 5)), lte: mE }, ignored: false },
      select: { type: true, amount: true, date: true },
    }),

    db.bill.aggregate({ where: { userId: uid, isPaid: false, dueDate: { lte: mE } }, _sum: { amount: true } }),

    // Fix 2: all unsettled person payables up to end of current month (not just this month)
    db.personEntry.aggregate({ where: { userId: uid, type: 'I_OWE_THEM', isSettled: false, date: { lte: mE } }, _sum: { amount: true } }),

    // "A Pagar" modal: current month + overdue. NO take — the modal groups these
    // by person and shows a per-person TOTAL, so it needs ALL entries (a take:4
    // made the per-person total count only 4 of N entries → undercounted, e.g.
    // Michele R$1.303 in the modal vs R$5.559 real).
    db.personEntry.findMany({
      where:   { userId: uid, type: 'I_OWE_THEM', isSettled: false, date: { lte: mE } },
      orderBy: { date: 'asc' },
      include: { person: { select: { name: true } } },
    }),

    // "Compromissos com pessoas" section: broader 45-day view (can include next month)
    db.personEntry.findMany({
      where:   { userId: uid, type: 'I_OWE_THEM', isSettled: false, date: { lte: addDays(now, 45) } },
      orderBy: { date: 'asc' }, take: 4,
      include: { person: { select: { name: true } } },
    }),

    // "A Receber" modal — grouped per-person total, so no take (same fix as A Pagar)
    db.personEntry.findMany({
      where:   { userId: uid, type: 'THEY_OWE_ME', isSettled: false, date: { lte: addDays(now, 45) } },
      orderBy: { date: 'asc' },
      include: { person: { select: { name: true } } },
    }),

    // Used to classify month income transactions as fixed/recurring vs avulso (name-matching)
    db.incomeSource.findMany({ where: { userId: uid, isRecurring: true }, select: { id: true, name: true, amount: true } }),
    db.recurringTransaction.findMany({ where: { userId: uid, isActive: true, frequency: 'MONTHLY' }, select: { id: true, name: true, amount: true, type: true } }),

    // Fix 3: budgets for overBudgetCount — merged into main Promise.all
    db.budget.findMany({ where: { userId: uid, month: yearMonth }, select: { categoryId: true, amount: true } }),
    // Current-month person entries — for recurring template duplicate detection
    db.personEntry.findMany({ where: { userId: uid, date: { gte: mS, lte: mE }, installmentGroupId: null }, select: { type: true, description: true } }),
    ]),

    // "Próximos meses" widget — reuses the same engine as /api/v1/projection so the
    // numbers stay consistent with /income, /bills and /people (installments, recurrences,
    // PersonEntryRecurring, etc). The dashboard widget shows the 5 months AFTER the current one.
    getProjection(uid, 6),
  ])

  // ── Derived values ───────────────────────────────────────────────────────────

  // rawPendingIncomeSources already filters via lastAutoPayMonth (set atomically in $transaction
  // when auto-pay or manual receipt runs). A name-based cross-check breaks when two sources
  // share the same name — one received transaction would incorrectly hide the other pending one.
  const pendingIncomeSources = rawPendingIncomeSources as { id: string; name: string; amount: unknown; isRecurring: boolean; dayOfMonth: number | null }[]

  // Classify month income transactions as fixed/recurring vs avulso (one-off) by matching
  // their description against known recurring income source / recurring transaction names —
  // Transaction has no FK back to its originating template, so name-matching is the best signal.
  const recurringIncomeNames = new Set([
    ...(recurringIncomeSources as { name: string }[]).map(s => s.name),
    ...(recurringTransactionItems as { name: string; type: string }[]).filter(t => t.type === 'INCOME').map(t => t.name),
  ])
  const monthIncomeTransactions = (monthIncomeTx as { id: string; description: string | null }[]).map(tx => ({
    ...tx,
    isRecurringIncome: tx.description ? recurringIncomeNames.has(tx.description) : false,
  }))

  const monthPeopleReceived = (monthPeopleReceivedRaw as { settledAt: Date | null }[]).map(({ settledAt, ...rest }) => ({
    ...rest,
    date: settledAt,
  }))

  // Recurring templates without a matching PersonEntry this month (same logic as /api/v1/people)
  const monthEntries = currentMonthPersonEntries as { type: string; description: string | null }[]
  const templates = allRecurringTemplates as { id: string; type: string; description: string | null; amount: unknown; dayOfMonth: number; person: { name: string } }[]
  const unprocessedTemplates = templates.filter(r =>
    !monthEntries.some(e => e.description === r.description && e.type === r.type)
  )
  const unprocessedReceivable = unprocessedTemplates.filter(r => r.type === 'THEY_OWE_ME')
  const unprocessedPayable    = unprocessedTemplates.filter(r => r.type === 'I_OWE_THEM')

  const totalPeopleReceivable = Number(peopleEntriesReceivable._sum.amount ?? 0)
    + unprocessedReceivable.reduce((s, r) => s + Number(r.amount), 0)
  const totalIncomeReceivable = pendingIncomeSources.reduce((sum: number, src) => sum + Number(src.amount), 0)
  const recurringPayableAmount = unprocessedPayable.reduce((s, r) => s + Number(r.amount), 0)

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
  // Built from the shared projection engine (same as /api/v1/projection) — keeps
  // this widget consistent with /income, /bills and /people, including installments,
  // recurrences and PersonEntryRecurring for each respective month.

  const toBreakdown = (items: ProjectionItem[], type: string, icon: string) =>
    items.filter(it => it.type === type).map(it => ({ id: it.id, label: it.label, amount: it.amount, icon }))

  const projected = projResult.slice(1).map(m => ({
    month:            m.monthStart.toISOString(),
    projectedIncome:  m.totalIncome,
    projectedExpense: m.totalExpense,
    projectedBalance: m.cumulativeBalance,
    incomeItems: {
      sources:   toBreakdown(m.incomeItems, 'income', '💰'),
      recurring: toBreakdown(m.incomeItems, 'recurring', '↻'),
      people:    toBreakdown(m.incomeItems, 'person', '👤'),
    },
    expenseItems: {
      bills:     toBreakdown(m.expenseItems, 'bill', '📄'),
      recurring: toBreakdown(m.expenseItems, 'recurring', '↻'),
      people:    toBreakdown(m.expenseItems, 'person', '👤'),
    },
  }))

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

  const accounts = await computeAccountBalances(uid)

  return ok(res, {
    userName:              user?.name ?? '',
    accounts,
    accountsTotal:         sumActiveBalances(accounts),
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
    monthIncomeTransactions: monthIncomeTransactions,
    monthPeopleReceived,
    goals,
    upcomingBills,
    upcomingPersonPayables: [
      ...(upcomingPersonPayables as any[]),
      ...unprocessedPayable.map(r => ({ id: r.id, description: r.description, amount: Number(r.amount), date: new Date().toISOString(), person: r.person, isRecurring: true })),
    ],
    futurePersonPayables,     // 45-day — Compromissos section
    upcomingPeopleReceivable: [
      ...(upcomingPeopleReceivable as any[]),
      ...unprocessedReceivable.map(r => ({ id: r.id, description: r.description, amount: Number(r.amount), date: new Date().toISOString(), person: r.person, isRecurring: true })),
    ],
    pendingBillsCount,
    pendingBillsAmount:    Number(pendingBillsAgg._sum.amount ?? 0),
    personPayablesAmount:  Number(personPayables._sum.amount ?? 0) + recurringPayableAmount,
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
