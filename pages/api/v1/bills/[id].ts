import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, noContent, notFound, badRequest } from '@/lib/respond'
import { parseISO, addMonths } from 'date-fns'

export default withAuth(async (req, res, session) => {
  const id = req.query.id as string

  // ── POST /api/v1/bills/:id?action=pay ─────────────────────────────────────
  if (req.method === 'POST' && req.query.action === 'pay') {
    const bill = await db.bill.findFirst({ where: { id, userId: session.userId } })
    if (!bill) return notFound(res)
    const { paid = true } = req.body

    if (paid && !bill.isPaid) {
      // Create EXPENSE transaction when marking as paid
      const categoryId = bill.categoryId ?? (
        await db.category.findFirst({ where: { OR: [{ isDefault: true }, { userId: session.userId }] }, orderBy: { isDefault: 'desc' } })
      )?.id ?? null

      const tx = await db.transaction.create({
        data: {
          amount:      bill.amount,
          type:        'EXPENSE',
          description: bill.name,
          date:        new Date(),
          userId:      session.userId,
          categoryId:  categoryId!,
        },
      })
      const updated = await db.bill.update({ where: { id }, data: { isPaid: true, paidAt: new Date(), paidTransactionId: tx.id } })

      // If recurring bill, auto-create next month's instance (only if one doesn't already exist)
      if (bill.isRecurring) {
        const nextDueDate  = addMonths(new Date(bill.dueDate), 1)
        const monthStart   = new Date(nextDueDate.getFullYear(), nextDueDate.getMonth(), 1)
        const monthEnd     = new Date(nextDueDate.getFullYear(), nextDueDate.getMonth() + 1, 0, 23, 59, 59)
        const alreadyExists = await db.bill.findFirst({
          where: { userId: session.userId, name: bill.name, isPaid: false, dueDate: { gte: monthStart, lte: monthEnd } },
        })
        if (!alreadyExists) {
          await db.bill.create({
            data: {
              name:        bill.name,
              amount:      bill.amount,
              dueDate:     nextDueDate,
              isRecurring: true,
              notes:       bill.notes ?? null,
              categoryId:  bill.categoryId ?? null,
              userId:      session.userId,
            },
          })
        }
      }

      return ok(res, updated)
    }

    if (!paid && bill.isPaid) {
      // Undo payment — remove the transaction if it exists
      if (bill.paidTransactionId) {
        await db.transaction.deleteMany({ where: { id: bill.paidTransactionId, userId: session.userId } })
      }
      const updated = await db.bill.update({ where: { id }, data: { isPaid: false, paidAt: null, paidTransactionId: null } })
      return ok(res, updated)
    }

    // No change needed (already in desired state)
    return ok(res, bill)
  }

  const bill = await db.bill.findFirst({ where: { id, userId: session.userId } })
  if (!bill) return notFound(res)

  if (req.method === 'GET') return ok(res, bill)

  if (req.method === 'PUT' || req.method === 'PATCH') {
    const { name, amount, dueDate, isRecurring, categoryId, notes } = req.body
    const updated = await db.bill.update({
      where: { id },
      data: {
        ...(name        !== undefined && { name }),
        ...(amount      !== undefined && { amount: parseFloat(amount) }),
        ...(dueDate     !== undefined && { dueDate: parseISO(dueDate) }),
        ...(isRecurring !== undefined && { isRecurring }),
        ...(categoryId  !== undefined && { categoryId: categoryId || null }),
        ...(notes       !== undefined && { notes: notes || null }),
      },
    })
    return ok(res, updated)
  }

  if (req.method === 'DELETE') {
    await db.bill.deleteMany({ where: { id, userId: session.userId } })
    return noContent(res)
  }

  return res.status(405).end()
})
