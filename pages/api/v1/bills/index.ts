import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, created, badRequest, planLimit } from '@/lib/respond'
import { addMonths } from 'date-fns'
import { randomUUID } from 'crypto'
import { getLimits } from '@/lib/plans'
import { checkAchievements } from '@/lib/achievement-checker'

async function generateRecurringBillsThisMonth(userId: string) {
  const now       = new Date()
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const y = now.getFullYear(), m = now.getMonth()
  // Fix 2: only fetch templates that haven't run this month yet — fast-path avoids
  // N queries when all templates are already processed.
  const templates = await db.recurringBill.findMany({
    where: { userId, isActive: true, OR: [{ lastAutoMonth: null }, { lastAutoMonth: { not: yearMonth } }] },
  })
  if (templates.length === 0) return
  for (const t of templates) {
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

    const { name, amount, dueDate, isRecurring = false, categoryId, installments = 1, alreadyPaid = 0, notes } = req.body
    if (!name || !amount || !dueDate) return badRequest(res, 'Nome, valor e vencimento são obrigatórios.')

    const [_by, _bm, _bd] = (dueDate as string).split('-').map(Number)
    const baseDate          = new Date(Date.UTC(_by, _bm - 1, _bd, 12, 0, 0))
    const numTotal          = parseInt(installments)
    const numAlreadyPaid    = Math.max(0, Math.min(parseInt(alreadyPaid) || 0, numTotal - 1))
    const numToCreate       = numTotal > 1 ? numTotal - numAlreadyPaid : 1

    if (limits.bills !== null) {
      // Fix 4: atomic limit check — count + create in one transaction to prevent
      // race conditions where two concurrent requests both pass the count check.
      const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
      const result = await db.$transaction(async (tx) => {
        const count = await tx.bill.count({ where: { userId: session.userId, isPaid: false, dueDate: { gte: monthStart } } })
        if (count + numToCreate > limits.bills!) return null
        return 'ok'
      })
      if (!result) return planLimit(res, `Limite de ${limits.bills} contas ativas atingido. Faça upgrade para o plano PRO.`)
    }

    if (numTotal > 1) {
      const groupId        = randomUUID()
      // amount received = total of remaining installments; per installment:
      const perInstallment = Math.round((parseFloat(amount) / numToCreate) * 100) / 100
      await db.bill.createMany({
        data: Array.from({ length: numToCreate }, (_, i) => ({
          name, amount: perInstallment,
          dueDate:             addMonths(baseDate, i),
          userId:              session.userId,
          categoryId:          categoryId ?? null,
          isRecurring:         false,
          notes:               notes ?? null,
          installmentTotal:    numTotal,                  // full total (e.g. 6/6)
          installmentCurrent:  numAlreadyPaid + i + 1,    // continues from alreadyPaid+1
          installmentGroupId:  groupId,
        })),
      })
      checkAchievements(db, session.userId, 'create-bill').catch(() => {})
      return created(res, { installmentGroupId: groupId, count: numToCreate })
    }

    const bill = await db.bill.create({
      data: { name, amount: parseFloat(amount), dueDate: baseDate, isRecurring, userId: session.userId, categoryId: categoryId ?? null, notes: notes ?? null },
    })
    checkAchievements(db, session.userId, 'create-bill').catch(() => {})
    return created(res, bill)
  }

  return res.status(405).end()
})
