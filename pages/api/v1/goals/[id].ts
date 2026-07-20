import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, created, noContent, notFound, badRequest } from '@/lib/respond'
import { parseISO } from 'date-fns'
import { checkAchievements } from '@/lib/achievement-checker'
import { sendGoalCompletedEmail } from '@/lib/email'
import { resolveFallbackCategoryId } from '@/lib/category-fallback'
import { resolveDefaultAccountId } from '@/lib/account-balances'

export default withAuth(async (req, res, session) => {
  const id = req.query.id as string

  if (req.method === 'POST' && req.query.action === 'contribute') {
    const { amount, note, categoryId } = req.body
    if (!amount) return badRequest(res, 'Valor obrigatório.')
    const amountNum = parseFloat(amount)
    if (!Number.isFinite(amountNum) || amountNum <= 0) return badRequest(res, 'Valor deve ser um número positivo.')
    const goal = await db.goal.findFirst({ where: { id, userId: session.userId } })
    if (!goal) return notFound(res)

    // Use provided categoryId, otherwise a savings category, else the shared
    // neutral fallback ("Outros", not "Moradia").
    const cat = categoryId
      ? { id: categoryId }
      : (await db.category.findFirst({
          where: { name: { contains: 'Poupan', mode: 'insensitive' }, OR: [{ isDefault: true }, { userId: session.userId }] },
        })) ?? { id: await resolveFallbackCategoryId(session.userId) }

    if (!cat?.id) return badRequest(res, 'Categoria não encontrada. Configure uma categoria padrão.')

    // Atomic increment (not "read currentAmount, add, write absolute value"):
    // Postgres applies `SET x = x + $1` as a single atomic row-level operation,
    // so two concurrent contributions (double-tap, two devices) can never lose
    // one of them — the old code read a stale currentAmount and overwrote it
    // with an absolute value, silently dropping whichever committed first even
    // though both Transaction/GoalContribution rows were created.
    const [updatedGoal, , contrib] = await db.$transaction([
      db.goal.update({ where: { id }, data: { currentAmount: { increment: amountNum } } }),
      db.transaction.create({
        data: { amount: amountNum, type: 'EXPENSE', description: `Aporte — ${goal.name}`, date: new Date(), userId: session.userId, categoryId: cat.id, accountId: await resolveDefaultAccountId(session.userId) },
      }),
      db.goalContribution.create({ data: { goalId: id, amount: amountNum, note: note ?? null } }),
    ])

    const isCompleted = Number(updatedGoal.currentAmount) >= Number(updatedGoal.targetAmount)
    if (isCompleted && !updatedGoal.isCompleted) {
      await db.goal.update({ where: { id }, data: { isCompleted: true, completedAt: new Date() } })
    }
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
