import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, noContent, notFound, badRequest } from '@/lib/respond'
import { checkAchievements } from '@/lib/achievement-checker'

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
      checkAchievements(db, session.userId, 'pay-bill', { billId: id }).catch(() => {})
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
        ...(dueDate !== undefined && dueDate && (() => {
          const [y, m, d] = (dueDate as string).split('-').map(Number)
          return { dueDate: new Date(Date.UTC(y, m - 1, d, 12, 0, 0)) }
        })()),
        ...(isRecurring !== undefined && { isRecurring }),
        ...(categoryId  !== undefined && { categoryId: categoryId || null }),
        ...(notes       !== undefined && { notes: notes || null }),
      },
    })
    return ok(res, updated)
  }

  if (req.method === 'DELETE') {
    if (bill.paidTransactionId) {
      await db.transaction.deleteMany({ where: { id: bill.paidTransactionId, userId: session.userId } })
    }
    await db.bill.deleteMany({ where: { id, userId: session.userId } })

    // Fix 3: if this bill was generated from a RecurringBill template, mark
    // the template as "already handled this month" so it won't regenerate.
    // Semantic: deleting = "skip this month, generate next month as usual."
    if (bill.recurringBillId) {
      const yearMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`
      await db.recurringBill.updateMany({
        where: { id: bill.recurringBillId, userId: session.userId },
        data:  { lastAutoMonth: yearMonth },
      })
    }

    return noContent(res)
  }

  return res.status(405).end()
})
