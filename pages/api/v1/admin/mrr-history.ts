import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'

const PRO_PRICE = 19.9

type MonthRow = { month: Date; new_pro: number }

export default withBackofficeAuth(async (_req, res) => {
  // PRO users registered per month (last 12 months, current PRO only)
  // Approximation: users who signed up as/before going PRO, counted by registration month
  const [byMonthRaw, currentPro, totalUsers] = await Promise.all([
    db.$queryRaw<MonthRow[]>`
      SELECT DATE_TRUNC('month', "createdAt")::date AS month, COUNT(*)::int AS new_pro
      FROM "User"
      WHERE plan = 'PRO' AND "createdAt" >= NOW() - INTERVAL '12 months'
      GROUP BY 1 ORDER BY 1
    `,
    db.user.count({ where: { plan: 'PRO' } }),
    db.user.count(),
  ])

  // Fill all 12 months (including months with 0 new PRO users)
  const now = new Date()
  const monthly: { month: string; newPro: number; mrr: number }[] = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const key = d.toISOString().slice(0, 7)
    const found = byMonthRaw.find(r => new Date(r.month).toISOString().slice(0, 7) === key)
    const newPro = found?.new_pro ?? 0
    monthly.push({ month: key, newPro, mrr: newPro * PRO_PRICE })
  }

  return ok(res, {
    monthly,
    currentPro,
    currentMrr: currentPro * PRO_PRICE,
    currentArr: currentPro * PRO_PRICE * 12,
    proRate: totalUsers > 0 ? Math.round((currentPro / totalUsers) * 100) : 0,
  })
}, ['GET'])
