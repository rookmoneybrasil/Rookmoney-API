import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, created, badRequest } from '@/lib/respond'

export default withAuth(async (req, res, session) => {
  if (req.method === 'GET') {
    const sources = await db.incomeSource.findMany({
      where:   { userId: session.userId },
      orderBy: { name: 'asc' },
      include: { category: { select: { id: true, name: true, icon: true, color: true } } },
    })
    return ok(res, sources)
  }

  if (req.method === 'POST') {
    const { name, type = 'EMPLOYMENT', amount, isRecurring = true, dayOfMonth, notes, categoryId } = req.body
    if (!name || !amount) return badRequest(res, 'Nome e valor são obrigatórios.')
    const source = await db.incomeSource.create({
      data: { name, type, amount: parseFloat(amount), isRecurring, dayOfMonth: dayOfMonth ? parseInt(dayOfMonth) : null, notes: notes ?? null, categoryId: categoryId ?? null, userId: session.userId },
    })
    return created(res, source)
  }

  return res.status(405).end()
})
