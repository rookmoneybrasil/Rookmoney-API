import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, noContent, notFound } from '@/lib/respond'
import { startOfMonth, endOfMonth } from 'date-fns'

export default withAuth(async (req, res, session) => {
  const id = req.query.id as string
  const item = await db.recurringTransaction.findFirst({ where: { id, userId: session.userId } })
  if (!item) return notFound(res)

  // POST /recurring/:id?action=toggle
  if (req.method === 'POST' && req.query.action === 'toggle') {
    const updated = await db.recurringTransaction.update({ where: { id }, data: { isActive: !item.isActive } })
    return ok(res, updated)
  }

  if (req.method === 'GET') return ok(res, item)

  if (req.method === 'PUT' || req.method === 'PATCH') {
    const { name, type, amount, frequency, dayOfMonth, description, categoryId, isActive } = req.body
    const updated = await db.recurringTransaction.update({
      where: { id },
      data: {
        ...(name        !== undefined && { name }),
        ...(type        !== undefined && { type }),
        ...(amount      !== undefined && { amount: parseFloat(amount) }),
        ...(frequency   !== undefined && { frequency }),
        ...(dayOfMonth  !== undefined && { dayOfMonth: dayOfMonth ? parseInt(dayOfMonth) : null }),
        ...(description !== undefined && { description }),
        ...(categoryId  !== undefined && { categoryId }),
        ...(isActive    !== undefined && { isActive }),
      },
      include: { category: { select: { id: true, name: true, icon: true, color: true } } },
    })
    // If value / name / category changed and a transaction was already auto-
    // generated this month, sync it too — otherwise a category-only edit never
    // reaches the current month's transaction (it kept the old category).
    const now = new Date()
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    if (item.lastAutoMonth === yearMonth && (amount !== undefined || name !== undefined || categoryId !== undefined)) {
      await db.transaction.updateMany({
        where: {
          userId:      session.userId,
          description: item.name,
          type:        item.type,
          date:        { gte: startOfMonth(now), lte: endOfMonth(now) },
        },
        data: {
          ...(amount !== undefined && { amount: parseFloat(amount) }),
          ...(name   !== undefined && { description: name }),
          ...(categoryId !== undefined && categoryId && { categoryId }),
        },
      })
    }

    return ok(res, updated)
  }

  if (req.method === 'DELETE') {
    await db.transaction.deleteMany({
      where: { userId: session.userId, description: item.name, type: item.type },
    })
    await db.recurringTransaction.deleteMany({ where: { id, userId: session.userId } })
    return noContent(res)
  }

  return res.status(405).end()
})
