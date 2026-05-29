import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, created, badRequest } from '@/lib/respond'
import { format } from 'date-fns'

export default withAuth(async (req, res, session) => {
  const month = (req.query.month as string) ?? format(new Date(), 'yyyy-MM')

  if (req.method === 'GET') {
    const budgets = await db.budget.findMany({
      where:   { userId: session.userId, month },
      include: { category: { select: { id: true, name: true, icon: true, color: true } } },
    })
    // Attach spent amounts
    const [y, m] = month.split('-').map(Number)
    const start = new Date(y, m - 1, 1)
    const end   = new Date(y, m, 0, 23, 59, 59, 999)
    const result = await Promise.all(budgets.map(async (b) => {
      const spent = await db.transaction.aggregate({ where: { userId: session.userId, categoryId: b.categoryId, type: 'EXPENSE', date: { gte: start, lte: end } }, _sum: { amount: true } })
      return { ...b, spent: Number(spent._sum.amount ?? 0) }
    }))
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
