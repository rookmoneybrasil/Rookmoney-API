import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, noContent, notFound, badRequest } from '@/lib/respond'
import { resolveFallbackCategoryId } from '@/lib/category-fallback'

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

    // Propagate a category change to the Transactions this template's PAID bills
    // already generated (linked via Bill.paidTransactionId) — otherwise editing
    // the Conta Fixa's category leaves every past/current payment's Transaction
    // stuck on the old category (the "troquei a categoria da conta mas a
    // transação continua Moradia" report). Only the category is re-filed, never
    // amount/name: a Transaction's value/description is a historical financial
    // fact, its category is a classification that's safe to correct retroactively.
    if (categoryId !== undefined) {
      const txCategoryId = categoryId || (await resolveFallbackCategoryId(session.userId))
      if (txCategoryId) {
        const paidBills = await db.bill.findMany({
          where:  { recurringBillId: id, userId: session.userId, paidTransactionId: { not: null } },
          select: { paidTransactionId: true },
        })
        const txIds = paidBills.map(b => b.paidTransactionId).filter((v): v is string => !!v)
        if (txIds.length) {
          await db.transaction.updateMany({
            where: { id: { in: txIds }, userId: session.userId },
            data:  { categoryId: txCategoryId },
          })
        }
      }
    }

    // Pausing a template removes THIS month's obligation (rule: "desativar para
    // o mês atual e futuros"). Delete only the current-month UNPAID generated
    // bill so it stops counting in every KPI — paid ones stay as history, and
    // past-month overdue bills stay (independent "atrasos"). Reactivating lets
    // the generator recreate a fresh pending one.
    if (isActive === false) {
      const now        = new Date()
      const monthStart = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1))
      const monthEnd   = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59))
      await db.bill.deleteMany({
        where: { recurringBillId: id, userId: session.userId, isPaid: false, dueDate: { gte: monthStart, lte: monthEnd } },
      })
    } else if (categoryId !== undefined || name !== undefined || amount !== undefined || notes !== undefined) {
      // Keep this month's already-generated UNPAID bill in sync with the template.
      // ensureMonthBill (process-recurring-bills.ts) only creates/adopts a bill —
      // it never re-syncs an existing one — so without this a category (or value)
      // edit on the Conta Fixa doesn't reach the current month's bill, and paying
      // it snapshots the OLD category into the Transaction (a null category then
      // falls back to the first default, "Moradia"). Paid bills stay as history.
      const now        = new Date()
      const monthStart = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1))
      const monthEnd   = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59))
      await db.bill.updateMany({
        where: { recurringBillId: id, userId: session.userId, isPaid: false, dueDate: { gte: monthStart, lte: monthEnd } },
        data: {
          ...(categoryId !== undefined && { categoryId: categoryId || null }),
          ...(name       !== undefined && { name }),
          ...(amount     !== undefined && { amount: parseFloat(amount) }),
          ...(notes      !== undefined && { notes: notes || null }),
        },
      })
    }
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
