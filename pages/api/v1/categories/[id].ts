import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, noContent, notFound, forbidden, badRequest } from '@/lib/respond'

export default withAuth(async (req, res, session) => {
  const id  = req.query.id as string
  const cat = await db.category.findUnique({ where: { id } })
  if (!cat) return notFound(res)
  if (cat.isDefault || cat.userId !== session.userId) return forbidden(res, 'Não é possível alterar categorias padrão.')

  if (req.method === 'GET') return ok(res, cat)

  if (req.method === 'PUT' || req.method === 'PATCH') {
    // Bug 5 fix: whitelist safe fields — never let req.body set isDefault or userId
    const { name, icon, color } = req.body as { name?: string; icon?: string; color?: string }
    const updated = await db.category.update({
      where: { id },
      data: {
        ...(name  !== undefined && { name  }),
        ...(icon  !== undefined && { icon  }),
        ...(color !== undefined && { color }),
      },
    })
    return ok(res, updated)
  }

  if (req.method === 'DELETE') {
    // Bug 6 fix: check if category is in use before deleting
    const usageCount = await db.transaction.count({ where: { categoryId: id } })
      + await db.bill.count({ where: { categoryId: id } })
      + await db.budget.count({ where: { categoryId: id } })
      + await db.recurringTransaction.count({ where: { categoryId: id } })
      + await db.incomeSource.count({ where: { categoryId: id } })
      + await db.recurringBill.count({ where: { categoryId: id } })
      + await db.personEntry.count({ where: { categoryId: id } })
      + await db.personEntryRecurring.count({ where: { categoryId: id } })
    if (usageCount > 0) {
      return badRequest(res, `Esta categoria está em uso em ${usageCount} registro(s). Reatribua-os antes de excluir.`)
    }
    await db.category.delete({ where: { id } })
    return noContent(res)
  }

  return res.status(405).end()
})
