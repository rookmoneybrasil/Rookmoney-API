import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, created, badRequest, planLimit } from '@/lib/respond'
import { addMonths } from 'date-fns'
import { randomUUID } from 'crypto'
import { getLimits } from '@/lib/plans'
import { checkAchievements } from '@/lib/achievement-checker'
import { processRecurringBills } from '@/lib/process-recurring-bills'
import { countActiveBillUnits } from '@/lib/bill-usage'

export default withAuth(async (req, res, session) => {
  if (req.method === 'GET') {
    // Generate this month's bills from active templates before returning the list
    await processRecurringBills(session.userId).catch(() => {})

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
    const parsedAmount = parseFloat(amount)
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) return badRequest(res, 'Valor deve ser um número positivo.')

    const [_by, _bm, _bd] = (dueDate as string).split('-').map(Number)
    const baseDate          = new Date(Date.UTC(_by, _bm - 1, _bd, 12, 0, 0))
    const numTotal          = parseInt(installments)
    const numAlreadyPaid    = Math.max(0, Math.min(parseInt(alreadyPaid) || 0, numTotal - 1))
    const numToCreate       = numTotal > 1 ? numTotal - numAlreadyPaid : 1

    if (limits.bills !== null) {
      // Fix 4: atomic limit check — count + create in one transaction to prevent
      // race conditions where two concurrent requests both pass the count check.
      // Uma conta parcelada conta como UMA conta (não uma por parcela): countActiveBillUnits
      // agrupa o parcelamento, e o que estamos criando adiciona sempre 1 unidade conceitual.
      const result = await db.$transaction(async (tx) => {
        const count = await countActiveBillUnits(tx, session.userId)
        if (count + 1 > limits.bills!) return null
        return 'ok'
      })
      if (!result) return planLimit(res, `Limite de ${limits.bills} contas ativas atingido. Faça upgrade para o plano PRO.`)
    }

    if (numTotal > 1) {
      const groupId        = randomUUID()
      const baseInstallment = Math.floor((parsedAmount / numToCreate) * 100) / 100
      const lastInstallment = Math.round((parsedAmount - baseInstallment * (numToCreate - 1)) * 100) / 100
      await db.bill.createMany({
        data: Array.from({ length: numToCreate }, (_, i) => ({
          name, amount: i === numToCreate - 1 ? lastInstallment : baseInstallment,
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
      data: { name, amount: parsedAmount, dueDate: baseDate, isRecurring, userId: session.userId, categoryId: categoryId ?? null, notes: notes ?? null },
    })
    checkAchievements(db, session.userId, 'create-bill').catch(() => {})
    return created(res, bill)
  }

  return res.status(405).end()
})
