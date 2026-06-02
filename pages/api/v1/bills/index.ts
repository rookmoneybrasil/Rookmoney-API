import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, created, badRequest, planLimit } from '@/lib/respond'
import { addMonths } from 'date-fns'
import { randomUUID } from 'crypto'
import { getLimits } from '@/lib/plans'

async function generateRecurringBillsThisMonth(userId: string) {
  const now       = new Date()
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const y = now.getFullYear(), m = now.getMonth()
  const templates = await db.recurringBill.findMany({ where: { userId, isActive: true } })
  for (const t of templates) {
    if (t.lastAutoMonth === yearMonth) continue
    const day     = Math.min(t.dayOfMonth, new Date(y, m + 1, 0).getDate())
    const dueDate = new Date(Date.UTC(y, m, day, 12, 0, 0))
    const exists  = await db.bill.findFirst({ where: { userId, recurringBillId: t.id, dueDate: { gte: new Date(Date.UTC(y, m, 1)), lte: new Date(Date.UTC(y, m + 1, 0, 23, 59, 59)) } } })
    if (!exists) {
      await db.bill.create({ data: { name: t.name, amount: t.amount, dueDate, isRecurring: false, userId, categoryId: t.categoryId ?? null, notes: t.notes ?? null, recurringBillId: t.id } })
    }
    await db.recurringBill.update({ where: { id: t.id }, data: { lastAutoMonth: yearMonth } })
  }
}

export default withAuth(async (req, res, session) => {
  if (req.method === 'GET') {
    // Generate this month's bills from active templates before returning the list
    await generateRecurringBillsThisMonth(session.userId).catch(() => {})

    const onlyPending = req.query.pending === 'true'
    const bills = await db.bill.findMany({
      where:   { userId: session.userId, ...(onlyPending ? { isPaid: false } : {}) },
      orderBy: { dueDate: 'asc' },
      include: { category: { select: { id: true, name: true, icon: true, color: true } } },
    })
    return ok(res, bills)
  }

  if (req.method === 'POST') {
    const limits = getLimits(session.plan ?? 'FREE')
    if (limits.bills !== null) {
      // Count only current-month-and-future unpaid bills — overdue from past months
      // shouldn't penalize users who haven't cleaned up yet.
      const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
      const count = await db.bill.count({ where: { userId: session.userId, isPaid: false, dueDate: { gte: monthStart } } })
      if (count >= limits.bills) {
        return planLimit(res, `Limite de ${limits.bills} contas ativas atingido. Faça upgrade para o plano PRO.`)
      }
    }

    const { name, amount, dueDate, isRecurring = false, categoryId, installments = 1, notes } = req.body
    if (!name || !amount || !dueDate) return badRequest(res, 'Nome, valor e vencimento são obrigatórios.')

    // Use UTC noon to avoid day-shift for Brazil (UTC-3) users
    const [_by, _bm, _bd] = (dueDate as string).split('-').map(Number)
    const baseDate = new Date(Date.UTC(_by, _bm - 1, _bd, 12, 0, 0))
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
