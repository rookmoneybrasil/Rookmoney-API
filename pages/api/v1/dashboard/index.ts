import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'
import { format, startOfMonth, endOfMonth, addDays } from 'date-fns'

export default withAuth(async (req, res, session) => {
  if (req.method !== 'GET') return res.status(405).end()

  const now   = new Date()
  const start = startOfMonth(now)
  const end   = endOfMonth(now)
  const uid   = session.userId

  const [income, expense, recentTx, goals, upcomingBills, pendingBills] = await Promise.all([
    db.transaction.aggregate({ where: { userId: uid, type: 'INCOME', date: { gte: start, lte: end } }, _sum: { amount: true } }),
    db.transaction.aggregate({ where: { userId: uid, type: 'EXPENSE', date: { gte: start, lte: end } }, _sum: { amount: true } }),
    db.transaction.findMany({ where: { userId: uid }, orderBy: { date: 'desc' }, take: 7, include: { category: { select: { name: true, icon: true, color: true } } } }),
    db.goal.findMany({ where: { userId: uid, isCompleted: false }, take: 3, orderBy: { createdAt: 'desc' } }),
    db.bill.findMany({ where: { userId: uid, isPaid: false, dueDate: { lte: addDays(now, 7) } }, orderBy: { dueDate: 'asc' }, take: 3 }),
    db.bill.count({ where: { userId: uid, isPaid: false } }),
  ])

  const totalIncome  = Number(income._sum.amount  ?? 0)
  const totalExpense = Number(expense._sum.amount ?? 0)

  return ok(res, {
    month:        format(now, 'MMMM yyyy'),
    totalIncome,
    totalExpense,
    balance:      totalIncome - totalExpense,
    recentTransactions: recentTx,
    activeGoals:        goals,
    upcomingBills,
    pendingBillsCount:  pendingBills,
  })
})
