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

  const notBot = { NOT: { email: { startsWith: 'bot-' } } } as const

  const [
    total, proStripe, proPlusStripe, proManual, proPlusManual,
    onlineUsers,
    prevMonthNewUsers,
    newToday, newThisWeek, newThisMonth,
    totalTransactions, transactionsThisMonth, totalGoals,
    recentUsers, openFeedback,
    recentFeedback,
    convProRaw, convProPlusRaw, churnProRaw, churnProPlusRaw,
    recentLogs,
    manualExpiringCount,
    androidUsers,
    iosUsers,
    emailDripStarted,
    emailDripCompleted,
    emailPromoSent,
    emailInactivitySent,
  ] = await Promise.all([
    db.user.count({ where: notBot }),
    db.user.count({ where: { ...notBot, plan: 'PRO', stripeSubscriptionId: { not: null } } }),
    db.user.count({ where: { ...notBot, plan: 'PRO_PLUS', stripeSubscriptionId: { not: null } } }),
    db.user.count({ where: { ...notBot, plan: 'PRO', stripeSubscriptionId: null } }),
    db.user.count({ where: { ...notBot, plan: 'PRO_PLUS', stripeSubscriptionId: null } }),
    db.user.count({ where: { ...notBot, lastActiveAt: { gte: fiveMinAgo } } }),
    db.user.count({ where: { ...notBot, createdAt: { gte: prevMonthStart, lte: prevMonthEnd } } }),
    db.user.count({ where: { ...notBot, createdAt: { gte: today } } }),
    db.user.count({ where: { ...notBot, createdAt: { gte: weekAgo } } }),
    db.user.count({ where: { ...notBot, createdAt: { gte: monthStart } } }),
    db.transaction.count(),
    db.transaction.count({ where: { createdAt: { gte: monthStart } } }),
    db.goal.count({ where: { isCompleted: false } }),
    db.user.findMany({ where: notBot, orderBy: { createdAt: 'desc' }, take: 8, select: { id: true, name: true, email: true, plan: true, createdAt: true } }),
    db.feedback.count({ where: { status: 'open' } }),
    db.feedback.findMany({
      where: { status: 'open' },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { id: true, type: true, title: true, createdAt: true, user: { select: { name: true } } },
    }),
    // Conversões PRO (Stripe upgrade to PRO + manual PRO activation)
    db.$queryRaw<[{ count: number }]>`
      SELECT COUNT(*)::int AS count FROM "AdminLog"
      WHERE "createdAt" >= ${monthStart}
      AND (
        (action = 'stripe_upgrade' AND details NOT LIKE '%PRO_PLUS%')
        OR (action = 'plan_change' AND (details LIKE 'Plano PRO manual%' OR details LIKE 'PRO prorrogado%'))
      )
    `,
    // Conversões PRO+
    db.$queryRaw<[{ count: number }]>`
      SELECT COUNT(*)::int AS count FROM "AdminLog"
      WHERE "createdAt" >= ${monthStart}
      AND (
        (action = 'stripe_upgrade' AND details LIKE '%PRO_PLUS%')
        OR (action = 'plan_change' AND (details LIKE 'Plano PRO+ manual%' OR details LIKE 'PRO+ prorrogado%'))
      )
    `,
    // Churn PRO
    db.$queryRaw<[{ count: number }]>`
      SELECT COUNT(*)::int AS count FROM "AdminLog"
      WHERE "createdAt" >= ${monthStart}
      AND (
        (action = 'stripe_downgrade' AND details NOT LIKE '%PRO_PLUS%')
        OR (action = 'plan_change' AND details LIKE '%de PRO para FREE%')
        OR (action = 'plan_change' AND details LIKE 'PRO manual expirado%')
      )
    `,
    // Churn PRO+
    db.$queryRaw<[{ count: number }]>`
      SELECT COUNT(*)::int AS count FROM "AdminLog"
      WHERE "createdAt" >= ${monthStart}
      AND (
        (action = 'stripe_downgrade' AND details LIKE '%PRO_PLUS%')
        OR (action = 'plan_change' AND details LIKE '%de PRO_PLUS para FREE%')
        OR (action = 'plan_change' AND details LIKE 'PRO+ manual expirado%')
      )
    `,
    db.adminLog.findMany({ orderBy: { createdAt: 'desc' }, take: 5 }),
    db.user.count({ where: { ...notBot, plan: { in: ['PRO', 'PRO_PLUS'] }, stripeSubscriptionId: null, proPlanExpiresAt: { not: null, lte: sevenDaysOn } } }),
    db.user.count({ where: { ...notBot, platform: 'android' } }),
    db.user.count({ where: { ...notBot, platform: 'ios' } }),
    // Email lifecycle stats
    db.user.count({ where: { ...notBot, lastDripEmailDay: { gte: 1 } } }),
    db.user.count({ where: { ...notBot, lastDripEmailDay: 7 } }),
    db.user.count({ where: { ...notBot, lastPromoEmailDay: { gte: 14 } } }),
    db.user.count({ where: { ...notBot, lastInactivityEmail: { not: null } } }),
  ])

  const totalPro      = proStripe + proManual
  const totalProPlus  = proPlusStripe + proPlusManual
  const totalPaid     = totalPro + totalProPlus
  const totalFree     = total - totalPaid
  const mrrPro        = proStripe * 19.90
  const mrrProPlus    = proPlusStripe * 34.90
  const mrr           = mrrPro + mrrProPlus

  const convPro       = convProRaw[0]?.count ?? 0
  const convProPlus   = convProPlusRaw[0]?.count ?? 0
  const churnPro      = churnProRaw[0]?.count ?? 0
  const churnProPlus  = churnProPlusRaw[0]?.count ?? 0

  return ok(res, {
    totalUsers: total,
    proUsers: totalPaid,
    freeUsers: totalFree,
    onlineUsers,
    proRate: total > 0 ? Math.round((totalPaid / total) * 100) : 0,
    newToday, newThisWeek, newThisMonth,
    totalTransactions, transactionsThisMonth, totalGoals,
    // PRO breakdown
    proTotal: totalPro, proStripe, proManual,
    mrrPro, convPro, churnPro,
    // PRO+ breakdown
    proPlusTotal: totalProPlus, proPlusStripe, proPlusManual,
    mrrProPlus, convProPlus, churnProPlus,
    // Totals
    mrr, arr: mrr * 12,
    openFeedbackCount: openFeedback,
    manualExpiringCount,
    growthVsLastMonth: prevMonthNewUsers > 0
      ? Math.round(((newThisMonth - prevMonthNewUsers) / prevMonthNewUsers) * 100)
      : null,
    recentFeedback,
    recentLogs,
    recentUsers,
    androidUsers,
    iosUsers,
    webOnlyUsers: total - androidUsers - iosUsers,
    emailDripStarted,
    emailDripCompleted,
    emailPromoSent,
    emailInactivitySent,
  })
})
