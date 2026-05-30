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
    const limits = getLimits(session.plan ?? 'FREE')
    if (limits.recurring !== null) {
      const count = await db.recurringTransaction.count({ where: { userId: session.userId, isActive: true } })
      if (count >= limits.recurring) {
        return planLimit(res, `Limite de ${limits.recurring} transações recorrentes atingido. Faça upgrade para o plano PRO.`)
      }
    }

    const { name, type, amount, frequency = 'MONTHLY', dayOfMonth, description, categoryId } = req.body
    if (!name || !type || !amount || !categoryId) return badRequest(res, 'Campos obrigatórios faltando.')
    const item = await db.recurringTransaction.create({
      data: { name, type, amount: parseFloat(amount), frequency, dayOfMonth: dayOfMonth ? parseInt(dayOfMonth) : null, description: description ?? null, categoryId, userId: session.userId },
      include: { category: { select: { id: true, name: true, icon: true, color: true } } },
    })
    return created(res, item)
  }

  return res.status(405).end()
})
