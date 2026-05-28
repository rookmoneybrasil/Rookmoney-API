import type { NextApiRequest, NextApiResponse } from 'next'
import { withAdminAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'

export default withAdminAuth(async (_req, res) => {
  const now        = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

  const [total, pro, newThisMonth, totalTransactions] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { plan: 'PRO' } }),
    db.user.count({ where: { createdAt: { gte: monthStart } } }),
    db.transaction.count(),
  ])

  return ok(res, {
    totalUsers: total, proUsers: pro, freeUsers: total - pro,
    proRate: total > 0 ? Math.round((pro / total) * 100) : 0,
    newThisMonth, totalTransactions,
    mrr: pro * 14.9,
    arr: pro * 14.9 * 12,
  })
})
