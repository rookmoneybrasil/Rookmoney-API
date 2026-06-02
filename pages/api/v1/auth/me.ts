import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, notFound } from '@/lib/respond'
import { getLimits } from '@/lib/plans'

export default withAuth(async (req, res, session) => {
  if (req.method !== 'GET') return res.status(405).end()

  const now        = new Date()
  const month      = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)
  const uid        = session.userId

  const [
    user,
    activeBills,       // reused for both badges and usage
    openPeople,
    budgets,
    monthExpenses,
    monthTransactions,
    goalsCount,
    peopleCount,
    customCategoriesCount,
    recurringCount,
  ] = await Promise.all([
    db.user.findUnique({
      where:  { id: uid },
      select: { id: true, name: true, email: true, plan: true, hasOnboarded: true, whatsappPhone: true, createdAt: true, profileImage: true },
    }),
    db.bill.count({ where: { userId: uid, isPaid: false, dueDate: { gte: monthStart } } }),
    db.person.count({ where: { userId: uid, entries: { some: { isSettled: false } } } }),
    db.budget.findMany({ where: { userId: uid, month }, select: { categoryId: true, amount: true } }),
    db.transaction.findMany({ where: { userId: uid, type: 'EXPENSE', date: { gte: monthStart, lte: monthEnd } }, select: { categoryId: true, amount: true } }),
    db.transaction.count({ where: { userId: uid, date: { gte: monthStart, lte: monthEnd } } }),
    db.goal.count({ where: { userId: uid, isCompleted: false } }),
    db.person.count({ where: { userId: uid } }),
    db.category.count({ where: { userId: uid, isDefault: false } }),
    db.recurringTransaction.count({ where: { userId: uid, isActive: true } }),
  ])

  const overBudgetCount = budgets.filter(b => {
    const spent = monthExpenses.filter(t => t.categoryId === b.categoryId).reduce((s, t) => s + Number(t.amount), 0)
    return spent >= Number(b.amount) * 0.8
  }).length

  if (!user) return notFound(res)

  const limits = getLimits(user.plan)

  return ok(res, {
    ...user,
    badges: { '/bills': activeBills, '/people': openPeople, '/budget': overBudgetCount },
    usage: {
      transactionsThisMonth: monthTransactions,
      bills:                 activeBills,
      goals:                 goalsCount,
      people:                peopleCount,
      customCategories:      customCategoriesCount,
      recurring:             recurringCount,
    },
    limits: {
      transactionsPerMonth: limits.transactionsPerMonth,
      bills:                limits.bills,
      goals:                limits.goals,
      people:               limits.people,
      customCategories:     limits.customCategories,
      recurring:            limits.recurring,
      budget:               limits.budget,
      reports:              limits.reports,
      projection:           limits.projection,
      import:               limits.import,
    },
  })
})
