import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, noContent, notFound } from '@/lib/respond'

export default withAuth(async (req, res, session) => {
  const groupId = req.query.groupId as string

  const count = await db.bill.count({ where: { installmentGroupId: groupId, userId: session.userId } })
  if (count === 0) return notFound(res)

  if (req.method === 'PATCH' || req.method === 'PUT') {
    const { name, amount, categoryId, notes } = req.body
    const data: Record<string, unknown> = {}
    if (name       !== undefined) data.name       = name
    if (amount     !== undefined) data.amount      = parseFloat(amount)
    if (categoryId !== undefined) data.categoryId  = categoryId || null
    if (notes      !== undefined) data.notes       = notes || null

    const { count: updated } = await db.bill.updateMany({
      where: { installmentGroupId: groupId, userId: session.userId, isPaid: false },
      data,
    })

    if (name !== undefined) {
      await db.bill.updateMany({
        where: { installmentGroupId: groupId, userId: session.userId, isPaid: true },
        data: { name },
      })
    }

    return ok(res, { updated })
  }

  if (req.method === 'DELETE') {
    await db.bill.deleteMany({ where: { installmentGroupId: groupId, userId: session.userId } })
    return noContent(res)
  }

  return res.status(405).end()
})
