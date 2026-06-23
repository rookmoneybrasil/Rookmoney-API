import type { NextApiRequest, NextApiResponse } from 'next'
import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'

export default withBackofficeAuth(async (_req, res) => {
  const now        = new Date()
  const today      = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const weekAgo    = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const prevMonthEnd   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59)

  const fiveMinAgo  = new Date(Date.now() - 5 * 60_000)
  const sevenDaysOn = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

  const [
    total, proStripe, proPlusStripe, proManual, proPlusManual,
    onlineUsers,
    prevMonthNewUsers,
    newToday, newThisWeek, newThisMonth,
    totalTransactions, transactionsThisMonth, totalGoals,
    recentUsers, openFeedback,
    recentFeedback,
    newProThisMonth,
    churnThisMonth,
    recentLogs,
    manualExpiringCount,
  ] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { plan: 'PRO', stripeSubscriptionId: { not: null } } }),
    db.user.count({ where: { plan: 'PRO_PLUS', stripeSubscriptionId: { not: null } } }),
    db.user.count({ where: { plan: 'PRO', stripeSubscriptionId: null } }),
    db.user.count({ where: { plan: 'PRO_PLUS', stripeSubscriptionId: null } }),
    db.user.count({ where: { lastActiveAt: { gte: fiveMinAgo } } }),
    db.user.count({ where: { createdAt: { gte: prevMonthStart, lte: prevMonthEnd } } }),
    db.user.count({ where: { createdAt: { gte: today } } }),
    db.user.count({ where: { createdAt: { gte: weekAgo } } }),
    db.user.count({ where: { createdAt: { gte: monthStart } } }),
    db.transaction.count(),
    db.transaction.count({ where: { createdAt: { gte: monthStart } } }),
    db.goal.count({ where: { isCompleted: false } }),
    db.user.findMany({ orderBy: { createdAt: 'desc' }, take: 8, select: { id: true, name: true, email: true, plan: true, createdAt: true } }),
    db.feedback.count({ where: { status: 'open' } }),
    db.feedback.findMany({
      where: { status: 'open' },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { id: true, type: true, title: true, createdAt: true, user: { select: { name: true } } },
    }),
    db.adminLog.count({ where: { action: 'plan_change', details: { contains: 'para PRO' }, createdAt: { gte: monthStart } } }),
    db.adminLog.count({ where: { action: 'plan_change', details: { contains: 'para FREE' }, createdAt: { gte: monthStart } } }),
    db.adminLog.findMany({ orderBy: { createdAt: 'desc' }, take: 5 }),
    db.user.count({ where: { plan: { in: ['PRO', 'PRO_PLUS'] }, stripeSubscriptionId: null, proPlanExpiresAt: { not: null, lte: sevenDaysOn } } }),
  ])

  const totalPro = proStripe + proManual
  const totalProPlus = proPlusStripe + proPlusManual
  const totalPaid = totalPro + totalProPlus
  const totalFree = total - totalPaid
  const mrr = proStripe * 19.90 + proPlusStripe * 34.90

  return ok(res, {
    totalUsers: total,
    proUsers: totalPaid,
    proPlusUsers: totalProPlus,
    proManual: proManual + proPlusManual,
    freeUsers: totalFree,
    onlineUsers,
    proRate: total > 0 ? Math.round((totalPaid / total) * 100) : 0,
    newToday, newThisWeek, newThisMonth,
    totalTransactions, transactionsThisMonth, totalGoals,
    mrr, arr: mrr * 12,
    proStripe, proPlusStripe,
    openFeedbackCount: openFeedback,
    newProThisMonth,
    churnThisMonth,
    manualExpiringCount,
    growthVsLastMonth: prevMonthNewUsers > 0
      ? Math.round(((newThisMonth - prevMonthNewUsers) / prevMonthNewUsers) * 100)
      : null,
    recentFeedback,
    recentLogs,
    recentUsers,
  })
})
