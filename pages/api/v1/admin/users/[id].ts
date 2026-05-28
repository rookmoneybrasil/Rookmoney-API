import { withAdminAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, noContent, notFound, forbidden } from '@/lib/respond'

export default withAdminAuth(async (req, res, session) => {
  const id   = req.query.id as string
  const user = await db.user.findUnique({ where: { id }, select: { id: true, name: true, email: true, plan: true, isAdmin: true, createdAt: true, stripeCustomerId: true, _count: { select: { transactions: true, goals: true, bills: true } } } })
  if (!user) return notFound(res)

  if (req.method === 'GET') return ok(res, user)

  if (req.method === 'PATCH') {
    const { plan, isAdmin } = req.body
    if (id === session.userId && isAdmin === false) return forbidden(res, 'Não pode remover próprio admin.')
    const updated = await db.user.update({
      where: { id },
      data: { ...(plan !== undefined && { plan }), ...(isAdmin !== undefined && { isAdmin }) },
    })
    return ok(res, { id: updated.id, plan: updated.plan, isAdmin: updated.isAdmin })
  }

  if (req.method === 'DELETE') {
    if (id === session.userId) return forbidden(res, 'Não pode deletar própria conta.')
    await db.user.delete({ where: { id } })
    return noContent(res)
  }

  return res.status(405).end()
})
