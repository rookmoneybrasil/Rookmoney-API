import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'

const PRO_PRICE = 19.9

type MonthRow    = { month: Date; count: number }
type TopUserRow  = { id: string; name: string; email: string; tx_count: number }

export default withBackofficeAuth(async (_req, res) => {
  const now = new Date()

  // ── Revenue: MRR history (Stripe PRO + manual PRO) last 12 months ────────────
  const [revenueStrikeRaw, revenueManualRaw] = await Promise.all([
    db.$queryRaw<MonthRow[]>`
      SELECT DATE_TRUNC('month', "createdAt")::date AS month, COUNT(*)::int AS count
      FROM "User"
      WHERE plan = 'PRO' AND "stripeSubscriptionId" IS NOT NULL
        AND "createdAt" >= NOW() - INTERVAL '12 months'
      GROUP BY 1 ORDER BY 1
    `,
    db.$queryRaw<MonthRow[]>`
      SELECT DATE_TRUNC('month', "createdAt")::date AS month, COUNT(*)::int AS count
      FROM "User"
      WHERE plan = 'PRO' AND "stripeSubscriptionId" IS NULL
        AND "createdAt" >= NOW() - INTERVAL '12 months'
      GROUP BY 1 ORDER BY 1
    `,
  ])

  // ── Acquisition: signups vs new PRO per month (last 12 months) ───────────────
  const [signupsRaw, newProRaw] = await Promise.all([
    db.$queryRaw<MonthRow[]>`
      SELECT DATE_TRUNC('month', "createdAt")::date AS month, COUNT(*)::int AS count
      FROM "User"
      WHERE "createdAt" >= NOW() - INTERVAL '12 months'
      GROUP BY 1 ORDER BY 1
    `,
    db.$queryRaw<MonthRow[]>`
      SELECT DATE_TRUNC('month', "createdAt")::date AS month, COUNT(*)::int AS count
      FROM "User"
      WHERE plan = 'PRO' AND "createdAt" >= NOW() - INTERVAL '12 months'
      GROUP BY 1 ORDER BY 1
    `,
  ])

  // ── Churn: plan_change → FREE per month (from admin logs) ────────────────────
  const churnRaw = await db.$queryRaw<MonthRow[]>`
    SELECT DATE_TRUNC('month', "createdAt")::date AS month, COUNT(*)::int AS count
    FROM "AdminLog"
    WHERE action = 'plan_change' AND details LIKE '%para FREE%'
      AND "createdAt" >= NOW() - INTERVAL '12 months'
    GROUP BY 1 ORDER BY 1
  `

  // ── Usage: top 10 most active users ──────────────────────────────────────────
  const [topUsersRaw, avgStats] = await Promise.all([
    db.$queryRaw<TopUserRow[]>`
      SELECT u.id, u.name, u.email, COUNT(t.id)::int AS tx_count
      FROM "User" u
      LEFT JOIN "Transaction" t ON t."userId" = u.id
      GROUP BY u.id, u.name, u.email
      ORDER BY tx_count DESC
      LIMIT 10
    `,
    db.$queryRaw<{ avg_tx: number; avg_goals: number }[]>`
      SELECT
        ROUND(AVG(tx_count), 1) AS avg_tx,
        ROUND(AVG(goal_count), 1) AS avg_goals
      FROM (
        SELECT u.id,
          COUNT(DISTINCT t.id) AS tx_count,
          COUNT(DISTINCT g.id) AS goal_count
        FROM "User" u
        LEFT JOIN "Transaction" t ON t."userId" = u.id
        LEFT JOIN "Goal"        g ON g."userId" = u.id
        GROUP BY u.id
      ) sub
    `,
  ])

  // Fill all 12 months
  const months: string[] = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push(d.toISOString().slice(0, 7))
  }

  function fill(raw: MonthRow[]) {
    return months.map(m => {
      const found = raw.find(r => new Date(r.month).toISOString().slice(0, 7) === m)
      return { month: m, count: found?.count ?? 0 }
    })
  }

  const revenueStripe = fill(revenueStrikeRaw)
  const revenueManual = fill(revenueManualRaw)
  const revenue = months.map((m, i) => ({
    month:      m,
    stripeNew:  revenueStripe[i].count,
    manualNew:  revenueManual[i].count,
    mrrStripe:  revenueStripe[i].count * PRO_PRICE,
    mrrManual:  revenueManual[i].count * PRO_PRICE,
    mrr:        (revenueStripe[i].count + revenueManual[i].count) * PRO_PRICE,
  }))

  const acquisition = months.map((m, i) => {
    const signups = fill(signupsRaw)[i].count
    const newPro  = fill(newProRaw)[i].count
    return { month: m, signups, newPro, conversionRate: signups > 0 ? Math.round((newPro / signups) * 100) : 0 }
  })

  const churn = fill(churnRaw).map(({ month, count }) => ({ month, churn: count }))

  const topUsers = topUsersRaw.map(u => ({ id: u.id, name: u.name, email: u.email, txCount: u.tx_count }))
  const avg      = avgStats[0] ?? { avg_tx: 0, avg_goals: 0 }

  return ok(res, { revenue, acquisition, churn, usage: { topUsers, avgTx: Number(avg.avg_tx), avgGoals: Number(avg.avg_goals) } })
}, ['GET'])
