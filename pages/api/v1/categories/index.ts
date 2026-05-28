import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, created, badRequest } from '@/lib/respond'

export default withAuth(async (req, res, session) => {
  if (req.method === 'GET') {
    const categories = await db.category.findMany({
      where:   { OR: [{ isDefault: true }, { userId: session.userId }] },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    })
    return ok(res, categories)
  }

  if (req.method === 'POST') {
    const { name, icon, color } = req.body
    if (!name || !icon || !color) return badRequest(res, 'Nome, ícone e cor são obrigatórios.')
    const category = await db.category.create({ data: { name, icon, color, userId: session.userId } })
    return created(res, category)
  }

  return res.status(405).end()
})
