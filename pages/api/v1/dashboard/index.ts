import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'
import { startOfMonth, endOfMonth, subMonths, addDays } from 'date-fns'

async function processAutoIncome(uid: string) {
  const now       = new Date()
  const today     = now.getDate()
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const sources   = await db.incomeSource.findMany({ where: { userId: uid, isRecurring: true, categoryId: { not: null } } })
  for (const src of sources) {
    if (src.lastAutoPayMonth === yearMonth) continue
    const day = src.dayOfMonth ?? 1
    if (today < day) continue
    await db.$transaction([
      db.transaction.create({ data: { amount: src.amount, type: 'INCOME', description: src.name, date: new Date(now.getFullYear(), now.getMonth(), day), userId: uid, categoryId: src.categoryId! } }),
      db.incomeSource.update({ where: { id: src.id }, data: { lastAutoPayMonth: yearMonth } }),
    ])
  }
}

async function processAutoRecurring(uid: string) {
  const now       = new Date()
  const today     = now.getDate()
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const items     = await db.recurringTransaction.findMany({ where: { userId: uid, isActive: true, frequency: 'MONTHLY', categoryId: { not: null } } })
  for (const item of items) {
    if (item.lastAutoMonth === yearMonth) continue
    const day = item.dayOfMonth ?? 1
    if (today < day) continue
    await db.$transaction([
      db.transaction.create({ data: { amount: item.amount, type: item.type, description: item.name, date: new Date(now.getFullYear(), now.getMonth(), day), userId: uid, categoryId: item.categoryId! } }),
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
    peopleReceivable,
    incomeReceivable,
    financialHealth,
    projections,
    pendingBillsAgg,
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
    db.bill.count({ where: { userId: uid, isPaid: false } }),
    db.bill.count({ where: { userId: uid, isPaid: false, dueDate: { lt: now } } }),
    db.bill.aggregate({ where: { userId: uid, isPaid: false }, _sum: { amount: true } }),
    // People receivable (entries where they owe me and not settled)
    db.personEntry.aggregate({ where: { userId: uid, type: 'THEY_OWE_ME', isSettled: false }, _sum: { amount: true } }),
    // Income sources receivable (eventual, not received this month)
    db.incomeSource.aggregate({ where: { userId: uid, isRecurring: false }, _sum: { amount: true } }),
    // Financial health score (simplified)
    db.transaction.findMany({ where: { userId: uid, date: { gte: startOfMonth(subMonths(now, 2)), lte: mE } }, select: { type: true, amount: true } }),
    // Projections (last 2 months average)
    db.transaction.findMany({ where: { userId: uid, date: { gte: startOfMonth(subMonths(now, 2)), lte: mE } }, select: { type: true, amount: true, date: true } }),
  ])

  const totalIncome  = Number(income._sum.amount  ?? 0)
  const totalExpense = Number(expense._sum.amount ?? 0)
  const prevTotalIncome  = Number(prevIncome._sum.amount  ?? 0)
  const prevTotalExpense = Number(prevExpense._sum.amount ?? 0)

  const incomeChange  = prevTotalIncome  > 0 ? Math.round(((totalIncome  - prevTotalIncome)  / prevTotalIncome)  * 100) : 0
  const expenseChange = prevTotalExpense > 0 ? Math.round(((totalExpense - prevTotalExpense) / prevTotalExpense) * 100) : 0

  // Simple financial health score
  const savingsRate = totalIncome > 0 ? (totalIncome - totalExpense) / totalIncome : 0
  const healthScore = Math.min(100, Math.max(0, Math.round(savingsRate * 100 + 50)))

  // 5-month projections: recurring income + recurring expenses + pending person entry installments
  const [recurringIncomeSources, recurringTransactions, pendingPersonEntries] = await Promise.all([
    db.incomeSource.findMany({ where: { userId: uid, isRecurring: true }, select: { amount: true } }),
    db.recurringTransaction.findMany({ where: { userId: uid, isActive: true, frequency: 'MONTHLY' }, select: { amount: true, type: true } }),
    // Person entries I owe (I_OWE_THEM) that are pending — represents monthly obligations
    db.personEntry.findMany({
      where: { userId: uid, type: 'I_OWE_THEM', isSettled: false, installmentGroupId: { not: null } },
      select: { amount: true, date: true, installmentGroupId: true, installmentCurrent: true, installmentTotal: true },
    }),
  ])

  const recurringIncome  = recurringIncomeSources.reduce((s, r) => s + Number(r.amount), 0)
    + recurringTransactions.filter(r => r.type === 'INCOME').reduce((s, r) => s + Number(r.amount), 0)
  const recurringExpense = recurringTransactions.filter(r => r.type === 'EXPENSE').reduce((s, r) => s + Number(r.amount), 0)

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

  return ok(res, {
    userName:              user?.name ?? '',
    monthBalance:          totalIncome - totalExpense,
    monthIncome:           totalIncome,
    monthExpense:          totalExpense,
    incomeChange,
    expenseChange,
    totalReceivable:       Number(peopleReceivable._sum.amount ?? 0) + Number(incomeReceivable._sum.amount ?? 0),
    totalPeopleReceivable: Number(peopleReceivable._sum.amount ?? 0),
    totalIncomeReceivable: Number(incomeReceivable._sum.amount ?? 0),
    recentTransactions:    recentTx,
    goals,
    upcomingBills,
    pendingBillsCount,
    pendingBillsAmount: Number(pendingBillsAgg._sum.amount ?? 0),
    overdueCount,
    healthScore,
    projections:           projected,
    mood: overdueCount > 0 ? 'angry' : totalIncome === 0 && totalExpense === 0 ? 'idle' : totalIncome - totalExpense >= 0 ? 'happy' : 'sad',
  })
})
