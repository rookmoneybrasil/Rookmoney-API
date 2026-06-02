import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, noContent, notFound } from '@/lib/respond'

export default withBackofficeAuth(async (req, res) => {
  const id   = req.query.id as string
  const user = await db.user.findUnique({
    where: { id },
    select: { id: true, name: true, email: true, plan: true, isAdmin: true, createdAt: true, updatedAt: true, whatsappPhone: true, stripeCustomerId: true, stripeSubscriptionId: true,
      _count: { select: { transactions: true, goals: true, bills: true, budgets: true, people: true } } }
  })
  if (!user) return notFound(res)

  if (req.method === 'GET') {
    const [recentTransactions, logs] = await Promise.all([
      db.transaction.findMany({
        where: { userId: id }, orderBy: { date: 'desc' }, take: 10,
        include: { category: { select: { name: true, icon: true, color: true } } },
      }),
      db.adminLog.findMany({
        where: { targetId: id }, orderBy: { createdAt: 'desc' }, take: 20,
      }),
    ])
    return ok(res, { user, recentTransactions, logs })
  }

  if (req.method === 'PATCH') {
    const { plan, isAdmin } = req.body
    const updated = await db.user.update({
      where: { id },
      data: { ...(plan !== undefined && { plan }), ...(isAdmin !== undefined && { isAdmin }) },
    })
    // Log the action
    if (plan !== undefined) {
      await db.adminLog.create({ data: { action: 'plan_change', targetId: id, details: `Plano alterado de ${user.plan} para ${plan} (${user.email})` } })
    }
    if (isAdmin !== undefined) {
      await db.adminLog.create({ data: { action: 'toggle_admin', targetId: id, details: `Admin ${isAdmin ? 'concedido' : 'removido'} de ${user.email}` } })
    }
    return ok(res, { id: updated.id, plan: updated.plan, isAdmin: updated.isAdmin })
  }

  if (req.method === 'DELETE') {
    await db.adminLog.create({ data: { action: 'delete_user', targetId: id, details: `Conta deletada: ${user.email} (${user.name})` } })
    await db.user.delete({ where: { id } })
    return noContent(res)
  }

  return res.status(405).end()
})
