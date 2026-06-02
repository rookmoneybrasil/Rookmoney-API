import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, created, badRequest, planRequired } from '@/lib/respond'
import { format } from 'date-fns'
import { getLimits } from '@/lib/plans'

export default withAuth(async (req, res, session) => {
  const limits = getLimits(session.plan ?? 'FREE')
  if (!limits.budget) return planRequired(res, 'Orçamento')

  const month = (req.query.month as string) ?? format(new Date(), 'yyyy-MM')

  if (req.method === 'GET') {
    const budgets = await db.budget.findMany({
      where:   { userId: session.userId, month },
      include: { category: { select: { id: true, name: true, icon: true, color: true } } },
    })
    if (!budgets.length) return ok(res, [])

    // Bug 4 fix: single query for all spending, grouped in memory — no N+1
    const [y, m] = month.split('-').map(Number)
    const start = new Date(y, m - 1, 1)
    const end   = new Date(y, m, 0, 23, 59, 59, 999)
    const spentTxs = await db.transaction.findMany({
      where:  { userId: session.userId, type: 'EXPENSE', date: { gte: start, lte: end }, categoryId: { in: budgets.map(b => b.categoryId) } },
      select: { categoryId: true, amount: true },
    })
    const spentMap = new Map<string, number>()
    for (const tx of spentTxs) spentMap.set(tx.categoryId, (spentMap.get(tx.categoryId) ?? 0) + Number(tx.amount))
    const result = budgets.map(b => ({ ...b, spent: spentMap.get(b.categoryId) ?? 0 }))
    return ok(res, result)
  }

  if (req.method === 'POST') {
    const { categoryId, amount } = req.body
    if (!categoryId || !amount) return badRequest(res, 'Categoria e valor são obrigatórios.')
    const budget = await db.budget.upsert({
      where:  { userId_categoryId_month: { userId: session.userId, categoryId, month } },
      update: { amount: parseFloat(amount) },
      create: { userId: session.userId, categoryId, month, amount: parseFloat(amount) },
    })
    return created(res, budget)
  }

  return res.status(405).end()
})
