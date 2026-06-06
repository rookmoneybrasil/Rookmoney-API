import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, noContent, notFound, badRequest } from '@/lib/respond'

export default withBackofficeAuth(async (req, res) => {
  const id = req.query.id as string

  const category = await db.category.findFirst({ where: { id, isDefault: true } })
  if (!category) return notFound(res, 'Categoria padrão não encontrada.')

  if (req.method === 'PATCH') {
    const { name, icon, color } = req.body
    if (!name?.trim() || !icon?.trim() || !color?.trim()) {
      return badRequest(res, 'Nome, ícone e cor são obrigatórios.')
    }
    const updated = await db.category.update({
      where: { id },
      data:  { name: name.trim(), icon: icon.trim(), color: color.trim() },
    })
    return ok(res, updated)
  }

  if (req.method === 'DELETE') {
    await db.category.delete({ where: { id } })
    return noContent(res)
  }

  return res.status(405).end()
})
