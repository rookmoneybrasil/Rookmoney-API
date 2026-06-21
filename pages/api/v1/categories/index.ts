import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, created, badRequest, planLimit } from '@/lib/respond'
import { getLimits } from '@/lib/plans'

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

    const limits = getLimits(session.plan ?? 'FREE')
    if (limits.customCategories !== null) {
      const allowed = await db.$transaction(async (tx) => {
        const count = await tx.category.count({ where: { userId: session.userId, isDefault: false } })
        return count < limits.customCategories!
      })
      if (!allowed) return planLimit(res, `Limite de ${limits.customCategories} categorias customizadas atingido. Faça upgrade para o plano PRO.`)
    }

    const category = await db.category.create({ data: { name, icon, color, userId: session.userId } })
    return created(res, category)
  }

  return res.status(405).end()
})
