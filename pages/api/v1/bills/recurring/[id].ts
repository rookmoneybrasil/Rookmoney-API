import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, noContent, notFound, badRequest } from '@/lib/respond'

export default withAuth(async (req, res, session) => {
  const id       = req.query.id as string
  const template = await db.recurringBill.findFirst({ where: { id, userId: session.userId } })
  if (!template) return notFound(res)

  if (req.method === 'GET') {
    const full = await db.recurringBill.findUnique({
      where: { id },
      include: { category: { select: { id: true, name: true, icon: true, color: true } } },
    })
    return ok(res, full)
  }

  if (req.method === 'PATCH') {
    const { name, amount, dayOfMonth, categoryId, notes, isActive } = req.body
    if (dayOfMonth !== undefined) {
      const day = parseInt(dayOfMonth)
      if (isNaN(day) || day < 1 || day > 31) return badRequest(res, 'Dia do mês deve ser entre 1 e 31.')
    }
    const updated = await db.recurringBill.update({
      where: { id },
      data: {
        ...(name       !== undefined && { name }),
        ...(amount     !== undefined && { amount: parseFloat(amount) }),
        ...(dayOfMonth !== undefined && { dayOfMonth: parseInt(dayOfMonth) }),
        ...(categoryId !== undefined && { categoryId: categoryId || null }),
        ...(notes      !== undefined && { notes: notes || null }),
        ...(isActive   !== undefined && { isActive: Boolean(isActive) }),
      },
      include: { category: { select: { id: true, name: true, icon: true, color: true } } },
    })
    return ok(res, updated)
  }

  if (req.method === 'DELETE') {
    // Delete all unpaid generated bills from this template, then delete template
    await db.bill.deleteMany({ where: { recurringBillId: id, userId: session.userId, isPaid: false } })
    await db.recurringBill.delete({ where: { id } })
    return noContent(res)
  }

  return res.status(405).end()
})
