import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, created, noContent, notFound, badRequest } from '@/lib/respond'
import { parseISO } from 'date-fns'
import { checkAchievements } from '@/lib/achievement-checker'
import { sendGoalCompletedEmail } from '@/lib/email'

export default withAuth(async (req, res, session) => {
  const id = req.query.id as string

  if (req.method === 'POST' && req.query.action === 'contribute') {
    const { amount, note, categoryId } = req.body
    if (!amount) return badRequest(res, 'Valor obrigatório.')
    const amountNum = parseFloat(amount)
    if (!Number.isFinite(amountNum) || amountNum <= 0) return badRequest(res, 'Valor deve ser um número positivo.')
    const goal = await db.goal.findFirst({ where: { id, userId: session.userId } })
    if (!goal) return notFound(res)
    const newAmount   = Number(goal.currentAmount) + amountNum
    const isCompleted = newAmount >= Number(goal.targetAmount)

    // Use provided categoryId, otherwise look for a savings category
    const cat = categoryId ? { id: categoryId } : await db.category.findFirst({
      where: { name: { contains: 'Poupan', mode: 'insensitive' }, OR: [{ isDefault: true }, { userId: session.userId }] },
    }) ?? await db.category.findFirst({
      where: { OR: [{ isDefault: true }, { userId: session.userId }] }, orderBy: { isDefault: 'desc' },
    })

    if (!cat?.id) return badRequest(res, 'Categoria não encontrada. Configure uma categoria padrão.')

    const [, , contrib] = await db.$transaction([
      db.goal.update({ where: { id }, data: { currentAmount: newAmount, isCompleted, completedAt: isCompleted ? new Date() : null } }),
      db.transaction.create({
        data: { amount: amountNum, type: 'EXPENSE', description: `Aporte — ${goal.name}`, date: new Date(), userId: session.userId, categoryId: cat.id },
      }),
      db.goalContribution.create({ data: { goalId: id, amount: amountNum, note: note ?? null } }),
    ])
    checkAchievements(db, session.userId, 'contribute-goal').catch(() => {})
    if (isCompleted) {
      const user = await db.user.findUnique({ where: { id: session.userId }, select: { email: true, name: true } })
      if (user) sendGoalCompletedEmail(user.email, user.name, goal.name, Number(goal.targetAmount)).catch(() => {})
    }
    return created(res, contrib)
  }

  // ── Withdraw / cancel contribution ────────────────────────────────────────
  if (req.method === 'POST' && req.query.action === 'withdraw') {
    const { amount } = req.body
    if (!amount) return badRequest(res, 'Valor obrigatório.')
    const amountNum = parseFloat(amount)
    if (!Number.isFinite(amountNum) || amountNum <= 0) return badRequest(res, 'Valor deve ser um número positivo.')
    const goal = await db.goal.findFirst({ where: { id, userId: session.userId } })
    if (!goal) return notFound(res)
    const newAmount = Math.max(0, Number(goal.currentAmount) - amountNum)

    const aporteDesc = `Aporte — ${goal.name}`
    const aportes = await db.transaction.findMany({
      where: { userId: session.userId, type: 'EXPENSE', description: aporteDesc },
      orderBy: { date: 'desc' },
    })

    let remaining = amountNum
    const toDelete: string[] = []
    let toShrink: { id: string; newAmount: number } | null = null

    for (const tx of aportes) {
      if (remaining <= 0) break
      const txAmt = Number(tx.amount)
      if (txAmt <= remaining) {
        toDelete.push(tx.id)
        remaining -= txAmt
      } else {
        toShrink = { id: tx.id, newAmount: txAmt - remaining }
        remaining = 0
      }
    }

    await db.$transaction([
      db.goal.update({ where: { id }, data: { currentAmount: newAmount, isCompleted: false, completedAt: null } }),
      ...(toDelete.length > 0
        ? [db.transaction.deleteMany({ where: { id: { in: toDelete } } })]
        : []),
      ...(toShrink
        ? [db.transaction.update({ where: { id: toShrink.id }, data: { amount: toShrink.newAmount } })]
        : []),
      db.goalContribution.create({
        data: { goalId: id, amount: -amountNum, note: 'Retirada' },
      }),
    ])

    return ok(res, { withdrawn: amountNum, newAmount })
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
    await db.transaction.deleteMany({
      where: {
        userId: session.userId,
        description: `Aporte — ${goal.name}`,
      },
    })
    await db.goal.deleteMany({ where: { id, userId: session.userId } })
    return noContent(res)
  }

  return res.status(405).end()
})
