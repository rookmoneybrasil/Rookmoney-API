import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'
import { format, subMonths, startOfMonth, endOfMonth } from 'date-fns'
import { ptBR } from 'date-fns/locale'

export default withAuth(async (req, res, session) => {
  if (req.method !== 'GET') return res.status(405).end()

  const months   = Math.min(Math.max(Number(req.query.months ?? 6), 1), 24)
  const uid      = session.userId
  const monthStr = req.query.month as string | undefined
  const endDate  = monthStr
    ? (() => { const [y, m] = monthStr.split('-').map(Number); return new Date(y, m - 1, 1) })()
    : new Date()
  const rangeStart = startOfMonth(subMonths(endDate, months - 1))
  const rangeEnd   = endOfMonth(endDate)

  const [allTxs, incomeSrcList] = await Promise.all([
    db.transaction.findMany({
      where:   { userId: uid, date: { gte: rangeStart, lte: rangeEnd } },
      include: { category: { select: { id: true, name: true, icon: true, color: true } } },
      orderBy: { date: 'asc' },
    }),
    db.incomeSource.findMany({ where: { userId: uid }, select: { name: true, amount: true } }),
  ])

  // Monthly breakdown
  const monthly = await Promise.all(
    Array.from({ length: months }, (_, i) => {
      const d     = subMonths(endDate, months - 1 - i)
      const start = startOfMonth(d)
      const end   = endOfMonth(d)
      const mTxs  = allTxs.filter(tx => new Date(tx.date) >= start && new Date(tx.date) <= end)
      const totalIncome  = mTxs.filter(t => t.type === 'INCOME') .reduce((s, t) => s + Number(t.amount), 0)
      const totalExpense = mTxs.filter(t => t.type === 'EXPENSE').reduce((s, t) => s + Number(t.amount), 0)
      return {
        monthKey:     format(d, 'yyyy-MM'),
        monthFull:    format(d, 'MMMM yyyy', { locale: ptBR }),
        totalIncome, totalExpense,
        balance:      totalIncome - totalExpense,
        savingsRate:  totalIncome > 0 ? Math.round(((totalIncome - totalExpense) / totalIncome) * 100) : 0,
      }
    })
  )

  // Period totals
  const periodIncome  = monthly.reduce((s, m) => s + m.totalIncome, 0)
  const periodExpense = monthly.reduce((s, m) => s + m.totalExpense, 0)
  const bestMonth     = monthly.reduce((best, m) => m.balance > (best?.balance ?? -Infinity) ? m : best, monthly[0])

  // Category trend
  const catMap = new Map<string, { name: string; icon: string; color: string; total: number; prevTotal: number }>()
  const prevStart = startOfMonth(subMonths(endDate, 1))
  const prevEnd   = endOfMonth(subMonths(endDate, 1))
  allTxs.filter(t => t.type === 'EXPENSE').forEach(tx => {
    const entry = catMap.get(tx.categoryId) ?? { name: tx.category.name, icon: tx.category.icon, color: tx.category.color, total: 0, prevTotal: 0 }
    entry.total += Number(tx.amount)
    if (new Date(tx.date) >= prevStart && new Date(tx.date) <= prevEnd) entry.prevTotal += Number(tx.amount)
    catMap.set(tx.categoryId, entry)
  })
  const totalExpForPct = Array.from(catMap.values()).reduce((s, v) => s + v.total, 0)
  const categoryTrend = Array.from(catMap.entries())
    .map(([id, v]) => ({
      categoryId: id, ...v,
      change: v.prevTotal > 0 ? Math.round(((v.total - v.prevTotal) / v.prevTotal) * 100) : 0,
      delta:  v.total - v.prevTotal,
      pct:    totalExpForPct > 0 ? Math.round((v.total / totalExpForPct) * 100) : 0,
    }))
    .sort((a, b) => b.total - a.total).slice(0, 10)

  // Top expenses
  const topExpenses = allTxs.filter(t => t.type === 'EXPENSE')
    .sort((a, b) => Number(b.amount) - Number(a.amount)).slice(0, 5)
    .map(t => ({ id: t.id, description: t.description, amount: Number(t.amount), date: t.date, category: t.category }))

  // Spending by day of month
  const dayMap = new Map<number, number>()
  allTxs.filter(t => t.type === 'EXPENSE').forEach(tx => {
    const day = new Date(tx.date).getDate()
    dayMap.set(day, (dayMap.get(day) ?? 0) + Number(tx.amount))
  })
  const spendingByDay = Array.from({ length: 31 }, (_, i) => ({ day: i + 1, total: dayMap.get(i + 1) ?? 0 }))

  // Income sources
  const incomeSourceMap = new Map<string, number>()
  allTxs.filter(t => t.type === 'INCOME').forEach(tx => {
    incomeSourceMap.set(tx.category.name, (incomeSourceMap.get(tx.category.name) ?? 0) + Number(tx.amount))
  })
  const incomeSources = Array.from(incomeSourceMap.entries())
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total)

  const worstMonth = monthly.reduce((worst, m) => m.balance < (worst?.balance ?? Infinity) ? m : worst, monthly[0])
  const positiveMonths = monthly.filter(m => m.balance >= 0).length

  return ok(res, {
    monthly,
    period: {
      totalIncome: periodIncome, totalExpense: periodExpense,
      balance: periodIncome - periodExpense,
      netBalance: periodIncome - periodExpense,
      savingsRate: periodIncome > 0 ? Math.round(((periodIncome - periodExpense) / periodIncome) * 100) : 0,
      avgMonthlyIncome:  months > 0 ? periodIncome  / months : 0,
      avgMonthlyExpense: months > 0 ? periodExpense / months : 0,
      positiveMonths, totalMonths: months,
      bestMonth: bestMonth?.monthFull ?? null,
      worstMonth: worstMonth?.monthFull ?? null,
    },
    categoryTrend,
    topExpenses,
    spendingByDay,
    incomeSources,
  })
})
