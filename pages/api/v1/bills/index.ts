import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, created, badRequest } from '@/lib/respond'
import { parseISO, addMonths } from 'date-fns'
import { randomUUID } from 'crypto'

export default withAuth(async (req, res, session) => {
  if (req.method === 'GET') {
    const onlyPending = req.query.pending === 'true'
    const bills = await db.bill.findMany({
      where:   { userId: session.userId, ...(onlyPending ? { isPaid: false } : {}) },
      orderBy: { dueDate: 'asc' },
      include: { category: { select: { id: true, name: true, icon: true, color: true } } },
    })
    return ok(res, bills)
  }

  if (req.method === 'POST') {
    const { name, amount, dueDate, isRecurring = false, categoryId, installments = 1, notes } = req.body
    if (!name || !amount || !dueDate) return badRequest(res, 'Nome, valor e vencimento são obrigatórios.')

    const baseDate = parseISO(dueDate)
    const numInstallments = parseInt(installments)

    if (numInstallments > 1) {
      const groupId = randomUUID()
      const perInstallment = Math.round((parseFloat(amount) / numInstallments) * 100) / 100
      await db.bill.createMany({
        data: Array.from({ length: numInstallments }, (_, i) => ({
          name, amount: perInstallment, dueDate: addMonths(baseDate, i),
          userId: session.userId, categoryId: categoryId ?? null, isRecurring: false,
          notes: notes ?? null, installmentTotal: numInstallments, installmentCurrent: i + 1,
          installmentGroupId: groupId,
        })),
      })
      return created(res, { installmentGroupId: groupId, count: numInstallments })
    }

    const bill = await db.bill.create({
      data: { name, amount: parseFloat(amount), dueDate: baseDate, isRecurring, userId: session.userId, categoryId: categoryId ?? null, notes: notes ?? null },
    })
    return created(res, bill)
  }

  return res.status(405).end()
})
