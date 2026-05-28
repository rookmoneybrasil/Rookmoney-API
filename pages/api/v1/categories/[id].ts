import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, noContent, notFound, forbidden } from '@/lib/respond'

export default withAuth(async (req, res, session) => {
  const id = req.query.id as string
  const cat = await db.category.findUnique({ where: { id } })
  if (!cat) return notFound(res)
  if (cat.isDefault || cat.userId !== session.userId) return forbidden(res, 'Não é possível alterar categorias padrão.')

  if (req.method === 'GET') return ok(res, cat)

  if (req.method === 'PUT' || req.method === 'PATCH') {
    const updated = await db.category.update({ where: { id }, data: req.body })
    return ok(res, updated)
  }

  if (req.method === 'DELETE') {
    await db.category.delete({ where: { id } })
    return noContent(res)
  }

  return res.status(405).end()
})
