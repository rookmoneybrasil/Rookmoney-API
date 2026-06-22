import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'

export default withBackofficeAuth(async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end()

  const { search = '', plan = '', inactive = '', page = '1', pageSize = '20' } = req.query as Record<string, string>
  const skip = (parseInt(page) - 1) * parseInt(pageSize)

  const where: Record<string, unknown> = {}

  if (plan === 'PRO_MANUAL') { where.plan = 'PRO'; where.stripeSubscriptionId = null }
  else if (plan === 'PRO' || plan === 'FREE') where.plan = plan

  if (inactive) {
    const days = parseInt(inactive)
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    where.OR = [{ lastActiveAt: null }, { lastActiveAt: { lte: cutoff } }]
  }

  if (search) {
    const searchClause = [
      { name:  { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ]
    where.OR = where.OR
      ? [{ AND: [{ OR: where.OR as unknown[] }, { OR: searchClause }] }]
      : searchClause
  }

  const [users, total] = await Promise.all([
    db.user.findMany({
      where, skip, take: parseInt(pageSize),
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, email: true, plan: true, isAdmin: true, createdAt: true,
        lastActiveAt: true, stripeSubscriptionId: true, profileImage: true,
        _count: { select: { transactions: true, goals: true } } },
    }),
    db.user.count({ where }),
  ])

  return ok(res, { users, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(pageSize)) })
})
