import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, created, noContent, notFound, badRequest } from '@/lib/respond'
import { parseISO } from 'date-fns'

export default withAuth(async (req, res, session) => {
  const id = req.query.id as string

  if (req.method === 'POST' && req.query.action === 'contribute') {
    const { amount, note } = req.body
    if (!amount) return badRequest(res, 'Valor obrigatório.')
    const goal = await db.goal.findFirst({ where: { id, userId: session.userId } })
    if (!goal) return notFound(res)
    const newAmount = Number(goal.currentAmount) + parseFloat(amount)
    const isCompleted = newAmount >= Number(goal.targetAmount)
    await db.goal.update({ where: { id }, data: { currentAmount: newAmount, isCompleted, completedAt: isCompleted ? new Date() : null } })
    const contrib = await db.goalContribution.create({ data: { goalId: id, amount: parseFloat(amount), note: note ?? null } })
    return created(res, contrib)
  }

  const goal = await db.goal.findFirst({ where: { id, userId: session.userId } })
  if (!goal) return notFound(res)

  if (req.method === 'GET')   return ok(res, goal)

  if (req.method === 'PUT' || req.method === 'PATCH') {
    const { name, targetAmount, deadline, description, icon, color } = req.body
    const updated = await db.goal.update({
      where: { id },
      data: {
        ...(name         !== undefined && { name }),
        ...(targetAmount !== undefined && { targetAmount: parseFloat(targetAmount) }),
        ...(deadline     !== undefined && { deadline: deadline ? parseISO(deadline) : null }),
        ...(description  !== undefined && { description }),
        ...(icon         !== undefined && { icon }),
        ...(color        !== undefined && { color }),
      },
    })
    return ok(res, updated)
  }

  if (req.method === 'DELETE') {
    await db.goal.deleteMany({ where: { id, userId: session.userId } })
    return noContent(res)
  }

  return res.status(405).end()
})
