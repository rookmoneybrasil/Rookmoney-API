import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'
import { startOfMonth, endOfMonth, subMonths, addDays, format, addMonths } from 'date-fns'

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

export default withAuth(async (req, res, session) => {
  if (req.method !== 'GET') return res.status(405).end()

  const uid  = session.userId
  const now  = new Date()

  // Auto-process recurring income and transactions (same behavior as monolith)
  await Promise.allSettled([processAutoIncome(uid), processAutoRecurring(uid)])
  const mS   = startOfMonth(now)
  const mE   = endOfMonth(now)
  const pmS  = startOfMonth(subMonths(now, 1))
  const pmE  = endOfMonth(subMonths(now, 1))

  const [
    user,
    income, expense,
    prevIncome, prevExpense,
    recentTx, goals, upcomingBills, pendingBillsCount,
    overdueCount,
    peopleEntriesReceivable,
    recurringPeopleReceivable,
    rawPendingIncomeSources,
    incomeThisMonth,
    financialHealth,
    projections,
    pendingBillsAgg,
    personPayables,
    upcomingPersonPayables,
    upcomingPeopleReceivable,
    historyTx,
    categoryTx,
  ] = await Promise.all([
    db.user.findUnique({ where: { id: uid }, select: { name: true } }),
    db.transaction.aggregate({ where: { userId: uid, type: 'INCOME',  date: { gte: mS, lte: mE } }, _sum: { amount: true } }),
    db.transaction.aggregate({ where: { userId: uid, type: 'EXPENSE', date: { gte: mS, lte: mE } }, _sum: { amount: true } }),
    db.transaction.aggregate({ where: { userId: uid, type: 'INCOME',  date: { gte: pmS, lte: pmE } }, _sum: { amount: true } }),
    db.transaction.aggregate({ where: { userId: uid, type: 'EXPENSE', date: { gte: pmS, lte: pmE } }, _sum: { amount: true } }),
    db.transaction.findMany({
      where: { userId: uid }, orderBy: { date: 'desc' }, take: 7,
      include: { category: { select: { name: true, icon: true, color: true } } },
    }),
    db.goal.findMany({ where: { userId: uid, isCompleted: false }, take: 3, orderBy: { createdAt: 'desc' } }),
    db.bill.findMany({
      where: { userId: uid, isPaid: false, dueDate: { lte: addDays(now, 14) } },
      orderBy: { dueDate: 'asc' }, take: 5,
    }),
    db.bill.count({ where: { userId: uid, isPaid: false, dueDate: { gte: mS, lte: mE } } }),
    db.bill.count({ where: { userId: uid, isPaid: false, dueDate: { lt: now } } }),
    // People receivable — pending entries (45 days) + active recurring templates
    db.personEntry.aggregate({ where: { userId: uid, type: 'THEY_OWE_ME', isSettled: false, date: { lte: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000) } }, _sum: { amount: true } }),
    // Recurring people receivable (monthly templates not yet generating entries)
    db.personEntryRecurring.aggregate({ where: { userId: uid, isActive: true, type: 'THEY_OWE_ME' }, _sum: { amount: true } }),
    // Income sources not yet received this month via lastAutoPayMonth flag
    db.incomeSource.findMany({ where: { userId: uid, OR: [{ lastAutoPayMonth: null }, { lastAutoPayMonth: { not: format(now, 'yyyy-MM') } }] }, select: { id: true, name: true, amount: true, isRecurring: true, dayOfMonth: true }, orderBy: { amount: 'desc' } }),
    // Income transactions this month — to cross-check against "pending" sources
    db.transaction.findMany({ where: { userId: uid, type: 'INCOME', date: { gte: mS, lte: mE } }, select: { description: true } }),
    // Financial health score (simplified)
    db.transaction.findMany({ where: { userId: uid, date: { gte: startOfMonth(subMonths(now, 2)), lte: mE } }, select: { type: true, amount: true } }),
    // Projections (last 2 months average)
    db.transaction.findMany({ where: { userId: uid, date: { gte: startOfMonth(subMonths(now, 2)), lte: mE } }, select: { type: true, amount: true, date: true } }),
    // Pending bills total amount — current month only
    db.bill.aggregate({ where: { userId: uid, isPaid: false, dueDate: { gte: mS, lte: mE } }, _sum: { amount: true } }),
    // Person entries where I owe them (payables) — current month only
    db.personEntry.aggregate({ where: { userId: uid, type: 'I_OWE_THEM', isSettled: false, date: { gte: mS, lte: mE } }, _sum: { amount: true } }),
    // Upcoming person payables list — I owe them (next ~45 days)
    db.personEntry.findMany({
      where:   { userId: uid, type: 'I_OWE_THEM', isSettled: false, date: { lte: addDays(now, 45) } },
      orderBy: { date: 'asc' },
      take:    4,
      include: { person: { select: { name: true } } },
    }),
    // Upcoming people receivable list — they owe me (next ~45 days)
    db.personEntry.findMany({
      where:   { userId: uid, type: 'THEY_OWE_ME', isSettled: false, date: { lte: addDays(now, 45) } },
      orderBy: { date: 'asc' },
      take:    5,
      include: { person: { select: { name: true } } },
    }),
    // Monthly history for sparklines (last 6 months)
    db.transaction.findMany({
      where:  { userId: uid, date: { gte: startOfMonth(subMonths(now, 5)), lte: mE } },
      select: { type: true, amount: true, date: true },
    }),
    // Top spending categories this month for donut chart
    db.transaction.findMany({
      where:   { userId: uid, type: 'EXPENSE', date: { gte: mS, lte: mE } },
      include: { category: { select: { name: true, icon: true, color: true } } },
    }),
  ])

  // Cross-check pending income sources with actual transactions this month.
  // Sources that already have a matching INCOME transaction (same name) are considered received,
  // even if lastAutoPayMonth wasn't updated (e.g. manual transaction without going through registerReceipt).
  const receivedSourceNames = new Set(
    (incomeThisMonth as { description: string | null }[]).map((t) => t.description).filter((d): d is string => Boolean(d))
  )
  const pendingIncomeSources = (rawPendingIncomeSources as { id: string; name: string; amount: unknown; isRecurring: boolean; dayOfMonth: number | null }[])
    .filter((s) => !receivedSourceNames.has(s.name))
  const totalPeopleReceivable  = Number(peopleEntriesReceivable._sum.amount ?? 0) + Number(recurringPeopleReceivable._sum.amount ?? 0)
  const totalIncomeReceivable  = pendingIncomeSources.reduce((sum: number, src) => sum + Number(src.amount), 0)

  const totalIncome  = Number(income._sum.amount  ?? 0)
  const totalExpense = Number(expense._sum.amount ?? 0)
  const prevTotalIncome  = Number(prevIncome._sum.amount  ?? 0)
  const prevTotalExpense = Number(prevExpense._sum.amount ?? 0)

  const incomeChange  = prevTotalIncome  > 0 ? Math.round(((totalIncome  - prevTotalIncome)  / prevTotalIncome)  * 100) : 0
  const expenseChange = prevTotalExpense > 0 ? Math.round(((totalExpense - prevTotalExpense) / prevTotalExpense) * 100) : 0

  // Simple financial health score
  const savingsRate = totalIncome > 0 ? (totalIncome - totalExpense) / totalIncome : 0
  const healthScore = Math.min(100, Math.max(0, Math.round(savingsRate * 100 + 50)))

  // 5-month projections: recurring income + recurring expenses + recurring bills + pending person installments
  const [recurringIncomeSources, recurringTransactions, pendingPersonEntries, recurringBills] = await Promise.all([
    db.incomeSource.findMany({ where: { userId: uid, isRecurring: true }, select: { amount: true } }),
    db.recurringTransaction.findMany({ where: { userId: uid, isActive: true, frequency: 'MONTHLY' }, select: { amount: true, type: true } }),
    // Person entries I owe (I_OWE_THEM) that are pending — represents monthly obligations
    db.personEntry.findMany({
      where: { userId: uid, type: 'I_OWE_THEM', isSettled: false, installmentGroupId: { not: null } },
      select: { amount: true, date: true, installmentGroupId: true, installmentCurrent: true, installmentTotal: true },
    }),
    // Recurring bills (isRecurring = true, not paid) — monthly fixed expenses
    db.bill.findMany({ where: { userId: uid, isRecurring: true, isPaid: false }, select: { amount: true } }),
  ])

  const recurringIncome  = recurringIncomeSources.reduce((s, r) => s + Number(r.amount), 0)
    + recurringTransactions.filter(r => r.type === 'INCOME').reduce((s, r) => s + Number(r.amount), 0)
  const recurringExpense = recurringTransactions.filter(r => r.type === 'EXPENSE').reduce((s, r) => s + Number(r.amount), 0)
    + recurringBills.reduce((s, b) => s + Number(b.amount), 0)  // recurring bills count as fixed monthly expenses

  // Calculate monthly person entry obligations (grouped by installmentGroupId, one entry = one month)
  const personGroupMap = new Map<string, number>()
  for (const e of pendingPersonEntries) {
    if (e.installmentGroupId && !personGroupMap.has(e.installmentGroupId)) {
      personGroupMap.set(e.installmentGroupId, Number(e.amount))
    }
  }
  const monthlyPersonObligation = Array.from(personGroupMap.values()).reduce((s, v) => s + v, 0)

  const projIncome     = recurringIncome > 0 ? recurringIncome : totalIncome
  const currentBalance = totalIncome - totalExpense

  const projected = Array.from({ length: 5 }, (_, i) => {
    const d           = addDays(mE, (i + 1) * 30)
    const mStart      = new Date(d.getFullYear(), d.getMonth(), 1)
    const mEnd        = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59)

    // Person entries due in this specific month
    const personExpInMonth = pendingPersonEntries
      .filter(e => { const ed = new Date(e.date); return ed >= mStart && ed <= mEnd })
      .reduce((s, e) => s + Number(e.amount), 0)

    // Use month-specific person amounts if available, else monthly average
    const monthPersonExp = personExpInMonth > 0 ? personExpInMonth : monthlyPersonObligation
    const monthExpense   = recurringExpense + monthPersonExp

    // Cumulative balance: start + all income - all expenses up to this month
    const cumulativeIncome  = projIncome * (i + 1)
    const cumulativeExpense = recurringExpense * (i + 1) + pendingPersonEntries
      .filter(e => new Date(e.date) <= mEnd && new Date(e.date) > mS)
      .reduce((s, e) => s + Number(e.amount), 0)

    return {
      month:            d.toISOString(),
      projectedIncome:  projIncome,
      projectedExpense: monthExpense,
      projectedBalance: currentBalance + cumulativeIncome - cumulativeExpense,
    }
  })

  // ── Monthly history (last 6 months) for sparklines ──────────────────────
  const monthlyHistory = Array.from({ length: 6 }, (_, i) => {
    const d     = subMonths(now, 5 - i)
    const month = format(d, 'yyyy-MM')
    const mStart = startOfMonth(d)
    const mEnd   = endOfMonth(d)
    const txs    = historyTx.filter(t => { const td = new Date(t.date); return td >= mStart && td <= mEnd })
    return {
      month,
      income:  txs.filter(t => t.type === 'INCOME').reduce((s, t) => s + Number(t.amount), 0),
      expense: txs.filter(t => t.type === 'EXPENSE').reduce((s, t) => s + Number(t.amount), 0),
    }
  })

  // ── Top categories this month for donut ──────────────────────────────────
  const catMap = new Map<string, { name: string; icon: string; color: string; amount: number }>()
  for (const t of categoryTx) {
    const cat = (t as unknown as { category: { name: string; icon: string; color: string } }).category
    if (!cat) continue
    const key = cat.name
    const cur = catMap.get(key)
    catMap.set(key, { name: cat.name, icon: cat.icon, color: cat.color, amount: (cur?.amount ?? 0) + Number(t.amount) })
  }
  const totalCatExpense = Array.from(catMap.values()).reduce((s, c) => s + c.amount, 0)
  const topCategories = Array.from(catMap.values())
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)
    .map(c => ({ ...c, pct: totalCatExpense > 0 ? Math.round((c.amount / totalCatExpense) * 100) : 0 }))

  // ── Rookinho insight ──────────────────────────────────────────────────────
  const daysInMonth  = endOfMonth(now).getDate()
  const dayOfMonth   = now.getDate()
  const pacePct      = totalIncome > 0 ? Math.round((totalExpense / totalIncome) * 100) : 0
  const topCat       = topCategories[0]

  let insight = ''
  if (overdueCount > 0) {
    insight = `Você tem ${overdueCount} conta${overdueCount > 1 ? 's' : ''} em atraso. Regularize para evitar juros.`
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
    goals,
    upcomingBills,
    upcomingPersonPayables,
    upcomingPeopleReceivable,
    pendingBillsCount,
    pendingBillsAmount:    Number(pendingBillsAgg._sum.amount ?? 0),
    personPayablesAmount:  Number(personPayables._sum.amount ?? 0),
    overdueCount,
    healthScore,
    projections:           projected,
    monthlyHistory,
    topCategories,
    insight,
    mood: overdueCount > 0 ? 'angry' : totalIncome === 0 && totalExpense === 0 ? 'idle' : totalIncome - totalExpense >= 0 ? 'happy' : 'sad',
    // Budget alerts: count of categories at 80%+ of limit this month
    overBudgetCount: await (async () => {
      const budgets = await db.budget.findMany({ where: { userId: uid, month: format(now, 'yyyy-MM') }, select: { categoryId: true, amount: true } })
      if (!budgets.length) return 0
      const txs = await db.transaction.findMany({ where: { userId: uid, type: 'EXPENSE', date: { gte: mS, lte: mE } }, select: { categoryId: true, amount: true } })
      return budgets.filter(b => {
        const spent = txs.filter(t => t.categoryId === b.categoryId).reduce((s, t) => s + Number(t.amount), 0)
        return spent >= Number(b.amount) * 0.8
      }).length
    })(),
  })
})

