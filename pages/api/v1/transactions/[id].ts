import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, noContent, notFound, badRequest, forbidden } from '@/lib/respond'
import { parseISO } from 'date-fns'

export default withAuth(async (req, res, session) => {
  const id = req.query.id as string

  const tx = await db.transaction.findFirst({ where: { id, userId: session.userId } })
  if (!tx) return notFound(res)

  if (req.method === 'GET') {
    return ok(res, tx)
  }

  if (req.method === 'PUT' || req.method === 'PATCH') {
    const { amount, type, description, date, categoryId } = req.body
    const updated = await db.transaction.update({
      where: { id },
      data: {
        ...(amount      !== undefined && { amount:      parseFloat(amount) }),
        ...(type        !== undefined && { type }),
        ...(description !== undefined && { description }),
        ...(date        !== undefined && { date: parseISO(date) }),
        ...(categoryId  !== undefined && { categoryId }),
      },
      include: { category: { select: { id: true, name: true, icon: true, color: true } } },
    })
    return ok(res, updated)
  }

  if (req.method === 'DELETE') {
    await db.bill.updateMany({
      where: { paidTransactionId: id, userId: session.userId },
      data:  { isPaid: false, paidAt: null, paidTransactionId: null },
    })

    // Reset income source / recurring transaction if this was auto-generated this month
    const now = new Date()
    const txDate = new Date(tx.date)
    if (txDate.getFullYear() === now.getFullYear() && txDate.getMonth() === now.getMonth() && tx.description) {
      const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
      if (tx.type === 'INCOME') {
        await db.incomeSource.updateMany({
          where: { userId: session.userId, name: tx.description, isRecurring: true, lastAutoPayMonth: yearMonth },
          data:  { lastAutoPayMonth: null },
        })
      }
      await db.recurringTransaction.updateMany({
        where: { userId: session.userId, name: tx.description, type: tx.type, lastAutoMonth: yearMonth },
        data:  { lastAutoMonth: null },
      })
    }

    await db.transaction.deleteMany({ where: { id, userId: session.userId } })
    return noContent(res)
  }

  return res.status(405).end()
})
