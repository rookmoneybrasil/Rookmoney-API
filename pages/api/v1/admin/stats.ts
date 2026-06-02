import type { NextApiRequest, NextApiResponse } from 'next'
import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'

export default withBackofficeAuth(async (_req, res) => {
  const now        = new Date()
  const today      = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const weekAgo    = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

  const [total, pro, newToday, newThisWeek, newThisMonth, totalTransactions, transactionsThisMonth, totalGoals, recentUsers, openFeedback] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { plan: 'PRO' } }),
    db.user.count({ where: { createdAt: { gte: today } } }),
    db.user.count({ where: { createdAt: { gte: weekAgo } } }),
    db.user.count({ where: { createdAt: { gte: monthStart } } }),
    db.transaction.count(),
    db.transaction.count({ where: { createdAt: { gte: monthStart } } }),
    db.goal.count({ where: { isCompleted: false } }),
    db.user.findMany({ orderBy: { createdAt: 'desc' }, take: 8, select: { id: true, name: true, email: true, plan: true, createdAt: true } }),
    db.feedback.count({ where: { status: 'open' } }),
  ])

  return ok(res, {
    totalUsers: total, proUsers: pro, freeUsers: total - pro,
    proRate: total > 0 ? Math.round((pro / total) * 100) : 0,
    newToday, newThisWeek, newThisMonth,
    totalTransactions, transactionsThisMonth, totalGoals,
    mrr: pro * 19.90, arr: pro * 19.90 * 12,
    openFeedbackCount: openFeedback,
    recentUsers,
  })
})
