import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'

const PRO_PRICE      = 19.9
const PRO_PLUS_PRICE = 34.9

type MonthRow = { month: Date; new_pro: number }

export default withBackofficeAuth(async (_req, res) => {
  // PRO + PRO_PLUS users registered per month (last 12 months)
  const [proByMonthRaw, plusByMonthRaw, currentPro, currentPlus, totalUsers] = await Promise.all([
    db.$queryRaw<MonthRow[]>`
      SELECT DATE_TRUNC('month', "createdAt")::date AS month, COUNT(*)::int AS new_pro
      FROM "User"
      WHERE plan = 'PRO' AND "stripeSubscriptionId" IS NOT NULL AND "createdAt" >= NOW() - INTERVAL '12 months'
      GROUP BY 1 ORDER BY 1
    `,
    db.$queryRaw<MonthRow[]>`
      SELECT DATE_TRUNC('month', "createdAt")::date AS month, COUNT(*)::int AS new_pro
      FROM "User"
      WHERE plan = 'PRO_PLUS' AND "stripeSubscriptionId" IS NOT NULL AND "createdAt" >= NOW() - INTERVAL '12 months'
      GROUP BY 1 ORDER BY 1
    `,
    db.user.count({ where: { plan: 'PRO', stripeSubscriptionId: { not: null } } }),
    db.user.count({ where: { plan: 'PRO_PLUS', stripeSubscriptionId: { not: null } } }),
    db.user.count(),
  ])

  // Fill all 12 months (including months with 0 new PRO/PRO_PLUS users)
  const now = new Date()
  const monthly: { month: string; newPro: number; mrr: number }[] = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const key = d.toISOString().slice(0, 7)
    const foundPro  = proByMonthRaw.find(r => new Date(r.month).toISOString().slice(0, 7) === key)
    const foundPlus = plusByMonthRaw.find(r => new Date(r.month).toISOString().slice(0, 7) === key)
    const newPro  = foundPro?.new_pro ?? 0
    const newPlus = foundPlus?.new_pro ?? 0
    monthly.push({ month: key, newPro: newPro + newPlus, mrr: newPro * PRO_PRICE + newPlus * PRO_PLUS_PRICE })
  }

  const currentMrr = currentPro * PRO_PRICE + currentPlus * PRO_PLUS_PRICE
  const totalPaid  = currentPro + currentPlus

  return ok(res, {
    monthly,
    currentPro: totalPaid,
    currentMrr,
    currentArr: currentMrr * 12,
    proRate: totalUsers > 0 ? Math.round((totalPaid / totalUsers) * 100) : 0,
  })
}, ['GET'])
