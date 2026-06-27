import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'

type DayRow   = { day: Date;   count: number }
type MonthRow = { month: Date; count: number }

export default withBackofficeAuth(async (_req, res) => {
  const [dailyRaw, monthlyRaw] = await Promise.all([
    db.$queryRaw<DayRow[]>`
      SELECT DATE_TRUNC('day', "createdAt")::date AS day, COUNT(*)::int AS count
      FROM "User"
      WHERE "createdAt" >= NOW() - INTERVAL '30 days'
        AND "email" NOT LIKE 'bot-%'
      GROUP BY 1 ORDER BY 1
    `,
    db.$queryRaw<MonthRow[]>`
      SELECT DATE_TRUNC('month', "createdAt")::date AS month, COUNT(*)::int AS count
      FROM "User"
      WHERE "createdAt" >= NOW() - INTERVAL '12 months'
        AND "email" NOT LIKE 'bot-%'
      GROUP BY 1 ORDER BY 1
    `,
  ])

  // Fill missing days with 0 so the chart always has 30 points
  const now = new Date()
  const daily: { date: string; count: number }[] = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now)
    d.setUTCDate(d.getUTCDate() - i)
    const key = d.toISOString().slice(0, 10)
    const found = dailyRaw.find(r => new Date(r.day).toISOString().slice(0, 10) === key)
    daily.push({ date: key, count: found?.count ?? 0 })
  }

  const monthly = monthlyRaw.map(r => ({
    month: new Date(r.month).toISOString().slice(0, 7),
    count: r.count,
  }))

  return ok(res, { daily, monthly })
}, ['GET'])
