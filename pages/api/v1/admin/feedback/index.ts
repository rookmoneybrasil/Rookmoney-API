import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'

export default withBackofficeAuth(async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end()

  const { status = '', type = '', search = '', page = '1', pageSize = '20' } = req.query as Record<string, string>
  const skip = (parseInt(page) - 1) * parseInt(pageSize)

  const where: Record<string, unknown> = {}
  if (status) where.status = status
  if (type)   where.type   = type
  if (search) where.OR = [
    { title: { contains: search, mode: 'insensitive' } },
    { body:  { contains: search, mode: 'insensitive' } },
  ]

  const [items, total] = await Promise.all([
    db.feedback.findMany({
      where, skip, take: parseInt(pageSize),
      orderBy: { createdAt: 'desc' },
      // Bug fix: exclude imageData from list (can be large base64 strings)
      // It's only loaded in the detail view via the full record
      select: {
        id: true, type: true, title: true, body: true, status: true, createdAt: true,
        imageData: false,
        user: { select: { id: true, name: true, email: true } },
      },
    }),
    db.feedback.count({ where }),
  ])

  return ok(res, { items, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(pageSize)) })
})
