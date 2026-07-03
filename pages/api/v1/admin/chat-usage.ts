import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'

type DayRow = { day: Date; channel: string; messages: number; costUsd: number }
type TopUserRow = { userId: string; name: string | null; email: string; plan: string; messages: number; costUsd: number }

export default withBackofficeAuth(async (_req, res) => {
  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)

  const [monthAgg, dailyRaw, topUsersRaw] = await Promise.all([
    db.chatUsageLog.aggregate({
      where: { createdAt: { gte: monthStart } },
      _count: { _all: true },
      _sum: { costUsd: true },
    }),
    db.$queryRaw<DayRow[]>`
      SELECT DATE_TRUNC('day', "createdAt")::date AS day, "channel",
             COUNT(*)::int AS messages, SUM("costUsd")::float AS "costUsd"
      FROM "ChatUsageLog"
      WHERE "createdAt" >= NOW() - INTERVAL '30 days'
      GROUP BY 1, 2 ORDER BY 1
    `,
    db.$queryRaw<TopUserRow[]>`
      SELECT l."userId", u."name", u."email", u."plan",
             COUNT(*)::int AS messages, SUM(l."costUsd")::float AS "costUsd"
      FROM "ChatUsageLog" l
      JOIN "User" u ON u."id" = l."userId"
      WHERE l."createdAt" >= NOW() - INTERVAL '30 days'
      GROUP BY 1, 2, 3, 4
      ORDER BY "costUsd" DESC
      LIMIT 20
    `,
  ])

  // Fill missing days so the chart always has 30 points, split by channel
  const now = new Date()
  const daily: { date: string; web: number; whatsapp: number; costUsd: number }[] = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now)
    d.setUTCDate(d.getUTCDate() - i)
    const key = d.toISOString().slice(0, 10)
    const rows = dailyRaw.filter(r => new Date(r.day).toISOString().slice(0, 10) === key)
    daily.push({
      date: key,
      web: rows.find(r => r.channel === 'web')?.messages ?? 0,
      whatsapp: rows.find(r => r.channel === 'whatsapp')?.messages ?? 0,
      costUsd: rows.reduce((sum, r) => sum + Number(r.costUsd ?? 0), 0),
    })
  }

  const totalMessages = monthAgg._count._all
  const totalCostUsd = Number(monthAgg._sum.costUsd ?? 0)
  const daysElapsed = Math.max(1, Math.ceil((Date.now() - monthStart.getTime()) / 86_400_000))
  const daysInMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate()

  return ok(res, {
    month: {
      totalMessages,
      totalCostUsd,
      avgCostPerMessage: totalMessages > 0 ? totalCostUsd / totalMessages : 0,
      projectedCostUsd: (totalCostUsd / daysElapsed) * daysInMonth,
    },
    daily,
    topUsers: topUsersRaw.map(r => ({
      userId: r.userId,
      name: r.name,
      email: r.email,
      plan: r.plan,
      messages: r.messages,
      costUsd: Number(r.costUsd ?? 0),
    })),
  })
}, ['GET'])
