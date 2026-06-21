import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, created, badRequest, planLimit } from '@/lib/respond'
import { getLimits } from '@/lib/plans'

export default withAuth(async (req, res, session) => {
  if (req.method === 'GET') {
    const items = await db.recurringTransaction.findMany({
      where:   { userId: session.userId },
      orderBy: { name: 'asc' },
      include: { category: { select: { id: true, name: true, icon: true, color: true } } },
    })
    return ok(res, items)
  }

  if (req.method === 'POST') {
    const { name, type, amount, frequency = 'MONTHLY', dayOfMonth, description, categoryId } = req.body
    if (!name || !type || !amount || !categoryId) return badRequest(res, 'Campos obrigatórios faltando.')
    if (!['INCOME', 'EXPENSE'].includes(type)) return badRequest(res, 'Tipo inválido.')
    const parsedAmount = parseFloat(amount)
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) return badRequest(res, 'Valor deve ser um número positivo.')
    const parsedDay = dayOfMonth ? parseInt(dayOfMonth) : null
    if (parsedDay !== null && (!Number.isFinite(parsedDay) || parsedDay < 1 || parsedDay > 31)) return badRequest(res, 'Dia do mês inválido.')

    const limits = getLimits(session.plan ?? 'FREE')
    if (limits.recurring !== null) {
      const allowed = await db.$transaction(async (tx) => {
        const count = await tx.recurringTransaction.count({ where: { userId: session.userId, isActive: true } })
        return count < limits.recurring!
      })
      if (!allowed) return planLimit(res, `Limite de ${limits.recurring} transações recorrentes atingido. Faça upgrade para o plano PRO.`)
    }

    const item = await db.recurringTransaction.create({
      data: { name, type, amount: parsedAmount, frequency, dayOfMonth: parsedDay, description: description ?? null, categoryId, userId: session.userId },
      include: { category: { select: { id: true, name: true, icon: true, color: true } } },
    })
    return created(res, item)
  }

  return res.status(405).end()
})
