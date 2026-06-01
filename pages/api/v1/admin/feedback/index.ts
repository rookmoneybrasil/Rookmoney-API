import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'

export default withBackofficeAuth(async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end()

  const { status = '', type = '', page = '1', pageSize = '20' } = req.query as Record<string, string>
  const skip = (parseInt(page) - 1) * parseInt(pageSize)

  const where: Record<string, unknown> = {}
  if (status) where.status = status
  if (type)   where.type   = type

  const [items, total] = await Promise.all([
    db.feedback.findMany({
      where, skip, take: parseInt(pageSize),
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, name: true, email: true } } },
    }),
    db.feedback.count({ where }),
  ])

  return ok(res, { items, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(pageSize)) })
})
