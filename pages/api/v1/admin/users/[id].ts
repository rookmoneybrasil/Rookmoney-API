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
    const recentTransactions = await db.transaction.findMany({
      where: { userId: id }, orderBy: { date: 'desc' }, take: 10,
      include: { category: { select: { name: true, icon: true, color: true } } },
    })
    return ok(res, { user, recentTransactions })
  }

  if (req.method === 'PATCH') {
    const { plan, isAdmin } = req.body
    const updated = await db.user.update({
      where: { id },
      data: { ...(plan !== undefined && { plan }), ...(isAdmin !== undefined && { isAdmin }) },
    })
    return ok(res, { id: updated.id, plan: updated.plan, isAdmin: updated.isAdmin })
  }

  if (req.method === 'DELETE') {
    await db.user.delete({ where: { id } })
    return noContent(res)
  }

  return res.status(405).end()
})
