import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'

export default withBackofficeAuth(async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end()

  const { page = '1', pageSize = '30' } = req.query as Record<string, string>
  const skip = (parseInt(page) - 1) * parseInt(pageSize)

  const [items, total] = await Promise.all([
    db.adminLog.findMany({
      orderBy: { createdAt: 'desc' },
      skip, take: parseInt(pageSize),
    }),
    db.adminLog.count(),
  ])

  return ok(res, { items, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(pageSize)) })
})
