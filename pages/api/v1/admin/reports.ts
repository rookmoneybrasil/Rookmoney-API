import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'

const PRO_PRICE      = 19.9
const PRO_PLUS_PRICE = 34.9

type MonthRow    = { month: Date; count: number }
type TopUserRow  = { id: string; name: string; email: string; tx_count: number }
type CohortRow   = { cohort_month: Date; total: number; active_30d: number }

export default withBackofficeAuth(async (_req, res) => {
  const now = new Date()

  // ── Revenue: MRR history (Stripe PRO/PRO_PLUS + manual PRO/PRO_PLUS) last 12 months ────────────
  const [revenueStrikeRaw, revenueManualRaw, revenueStripePlusRaw, revenueManualPlusRaw] = await Promise.all([
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
    db.$queryRaw<MonthRow[]>`
      SELECT DATE_TRUNC('month', "createdAt")::date AS month, COUNT(*)::int AS count
      FROM "User"
      WHERE plan = 'PRO_PLUS' AND "stripeSubscriptionId" IS NOT NULL
        AND "createdAt" >= NOW() - INTERVAL '12 months'
      GROUP BY 1 ORDER BY 1
    `,
    db.$queryRaw<MonthRow[]>`
      SELECT DATE_TRUNC('month', "createdAt")::date AS month, COUNT(*)::int AS count
      FROM "User"
      WHERE plan = 'PRO_PLUS' AND "stripeSubscriptionId" IS NULL
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
      WHERE plan IN ('PRO', 'PRO_PLUS') AND "createdAt" >= NOW() - INTERVAL '12 months'
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

  // ── Retention cohort: signups in last 12 months vs active last 30 days ───────
  const cohortRaw = await db.$queryRaw<CohortRow[]>`
    SELECT
      DATE_TRUNC('month', "createdAt")::date AS cohort_month,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE "lastActiveAt" >= NOW() - INTERVAL '30 days')::int AS active_30d
    FROM "User"
    WHERE "createdAt" >= NOW() - INTERVAL '12 months'
    GROUP BY 1 ORDER BY 1
  `

  // ── Onboarding funnel ─────────────────────────────────────────────────────────
  const [totalUsers, onboardedCount, txUsersRaw, goalUsersRaw] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { hasOnboarded: true } }),
    db.$queryRaw<{ count: number }[]>`SELECT COUNT(DISTINCT "userId")::int AS count FROM "Transaction"`,
    db.$queryRaw<{ count: number }[]>`SELECT COUNT(DISTINCT "userId")::int AS count FROM "Goal"`,
  ])

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

  const revenueStripe     = fill(revenueStrikeRaw)
  const revenueManual     = fill(revenueManualRaw)
  const revenueStripePlus = fill(revenueStripePlusRaw)
  const revenueManualPlus = fill(revenueManualPlusRaw)
  const revenue = months.map((m, i) => {
    const proStripe  = revenueStripe[i].count
    const proManual  = revenueManual[i].count
    const plusStripe  = revenueStripePlus[i].count
    const plusManual  = revenueManualPlus[i].count
    return {
      month:      m,
      stripeNew:  proStripe + plusStripe,
      manualNew:  proManual + plusManual,
      mrrStripe:  proStripe * PRO_PRICE + plusStripe * PRO_PLUS_PRICE,
      mrrManual:  proManual * PRO_PRICE + plusManual * PRO_PLUS_PRICE,
      mrr:        (proStripe + proManual) * PRO_PRICE + (plusStripe + plusManual) * PRO_PLUS_PRICE,
    }
  })

  const acquisition = months.map((m, i) => {
    const signups = fill(signupsRaw)[i].count
    const newPro  = fill(newProRaw)[i].count
    return { month: m, signups, newPro, conversionRate: signups > 0 ? Math.round((newPro / signups) * 100) : 0 }
  })

  const churn = fill(churnRaw).map(({ month, count }) => ({ month, churn: count }))

  const topUsers = topUsersRaw.map(u => ({ id: u.id, name: u.name, email: u.email, txCount: u.tx_count }))
  const avg      = avgStats[0] ?? { avg_tx: 0, avg_goals: 0 }

  const cohort = cohortRaw.map(r => ({
    cohortMonth:   new Date(r.cohort_month).toISOString().slice(0, 7),
    total:         r.total,
    active30d:     r.active_30d,
    retentionRate: r.total > 0 ? Math.round((r.active_30d / r.total) * 100) : 0,
  }))

  const funnel = {
    totalUsers,
    onboarded:       onboardedCount,
    hasTransactions: Number(txUsersRaw[0]?.count ?? 0),
    hasGoals:        Number(goalUsersRaw[0]?.count ?? 0),
  }

  return ok(res, {
    revenue, acquisition, churn,
    usage:   { topUsers, avgTx: Number(avg.avg_tx), avgGoals: Number(avg.avg_goals) },
    cohort,
    funnel,
  })
}, ['GET'])
