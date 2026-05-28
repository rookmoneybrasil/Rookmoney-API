import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, created, badRequest } from '@/lib/respond'
import { parseISO } from 'date-fns'

export default withAuth(async (req, res, session) => {
  if (req.method === 'GET') {
    const includeCompleted = req.query.completed === 'true'
    const goals = await db.goal.findMany({
      where:   { userId: session.userId, ...(includeCompleted ? {} : { isCompleted: false }) },
      orderBy: { createdAt: 'desc' },
      include: { contributions: { orderBy: { createdAt: 'desc' }, take: 5 } },
    })
    return ok(res, goals)
  }

  if (req.method === 'POST') {
    const { name, targetAmount, currentAmount = 0, deadline, description, icon, color } = req.body
    if (!name || !targetAmount) return badRequest(res, 'Nome e valor alvo são obrigatórios.')

    const goal = await db.goal.create({
      data: { name, targetAmount: parseFloat(targetAmount), currentAmount: parseFloat(currentAmount), deadline: deadline ? parseISO(deadline) : null, description: description ?? null, icon: icon ?? null, color: color ?? null, userId: session.userId },
    })
    return created(res, goal)
  }

  return res.status(405).end()
})
