import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, created, badRequest } from '@/lib/respond'

export default withBackofficeAuth(async (req, res) => {
  if (req.method === 'GET') {
    const categories = await db.category.findMany({
      where:   { isDefault: true },
      orderBy: { name: 'asc' },
      select:  { id: true, name: true, icon: true, color: true },
    })
    return ok(res, categories)
  }

  if (req.method === 'POST') {
    const { name, icon, color } = req.body
    if (!name?.trim() || !icon?.trim() || !color?.trim()) {
      return badRequest(res, 'Nome, ícone e cor são obrigatórios.')
    }
    const category = await db.category.create({
      data: { name: name.trim(), icon: icon.trim(), color: color.trim(), isDefault: true },
    })
    return created(res, category)
  }

  return res.status(405).end()
})
