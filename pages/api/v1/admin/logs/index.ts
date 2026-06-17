import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'

export default withBackofficeAuth(async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end()

  const { page = '1', pageSize = '30', action = '', search = '' } = req.query as Record<string, string>
  const skip = (parseInt(page) - 1) * parseInt(pageSize)

  const where: Record<string, unknown> = {}
  if (action) where.action = action
  if (search) where.details = { contains: search, mode: 'insensitive' }

  const [items, total] = await Promise.all([
    db.adminLog.findMany({
      where, orderBy: { createdAt: 'desc' },
      skip, take: parseInt(pageSize),
    }),
    db.adminLog.count({ where }),
  ])

  return ok(res, { items, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(pageSize)) })
})
