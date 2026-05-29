import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, notFound } from '@/lib/respond'

export default withAuth(async (req, res, session) => {
  if (req.method !== 'GET') return res.status(405).end()

  const now       = new Date()
  const month     = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)

  const [user, unpaidBills, openPeople, budgets, monthExpenses] = await Promise.all([
    db.user.findUnique({
      where:  { id: session.userId },
      select: { id: true, name: true, email: true, plan: true, hasOnboarded: true, whatsappPhone: true, createdAt: true },
    }),
    db.bill.count({ where: { userId: session.userId, isPaid: false } }),
    db.person.count({ where: { userId: session.userId, entries: { some: { isSettled: false } } } }),
    db.budget.findMany({ where: { userId: session.userId, month }, select: { categoryId: true, amount: true } }),
    db.transaction.findMany({ where: { userId: session.userId, type: 'EXPENSE', date: { gte: monthStart, lte: monthEnd } }, select: { categoryId: true, amount: true } }),
  ])

  // Count budgets that are >= 80% used (warning or over)
  const overBudgetCount = budgets.filter(b => {
    const spent = monthExpenses.filter(t => t.categoryId === b.categoryId).reduce((s, t) => s + Number(t.amount), 0)
    return spent >= Number(b.amount) * 0.8
  }).length

  if (!user) return notFound(res)
  return ok(res, {
    ...user,
    badges: { '/bills': unpaidBills, '/people': openPeople, '/budget': overBudgetCount },
  })
})
