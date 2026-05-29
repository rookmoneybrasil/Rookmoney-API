import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, noContent, notFound, badRequest } from '@/lib/respond'
import { parseISO } from 'date-fns'

export default withAuth(async (req, res, session) => {
  const id = req.query.id as string

  // ── POST /api/v1/bills/:id?action=pay ─────────────────────────────────────
  if (req.method === 'POST' && req.query.action === 'pay') {
    const bill = await db.bill.findFirst({ where: { id, userId: session.userId } })
    if (!bill) return notFound(res)
    const { paid = true } = req.body
    const updated = await db.bill.update({ where: { id }, data: { isPaid: paid, paidAt: paid ? new Date() : null } })
    return ok(res, updated)
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
