import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, created, badRequest, planLimit } from '@/lib/respond'
import { parseISO } from 'date-fns'
import { getLimits } from '@/lib/plans'
import { checkAchievements } from '@/lib/achievement-checker'

export default withAuth(async (req, res, session) => {
  // ── GET /api/v1/transactions ──────────────────────────────────────────────
  if (req.method === 'GET') {
    const { type, search, categoryId, month, page = '1', pageSize = '20' } = req.query as Record<string, string>
    const skip = (parseInt(page) - 1) * parseInt(pageSize)
    const take = parseInt(pageSize)

    const where: Record<string, unknown> = { userId: session.userId }
    if (type === 'INCOME' || type === 'EXPENSE') where.type = type
    if (categoryId) where.categoryId = categoryId
    if (month) {
      const start = new Date(month + '-01')
      const end   = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59)
      where.date  = { gte: start, lte: end }
    }
    if (search) where.description = { contains: search, mode: 'insensitive' }

    const [items, total] = await Promise.all([
      db.transaction.findMany({
        where, skip, take,
        orderBy: { date: 'desc' },
        include: { category: { select: { id: true, name: true, icon: true, color: true } } },
      }),
      db.transaction.count({ where }),
    ])

    return ok(res, { items, total, page: parseInt(page), totalPages: Math.ceil(total / take) })
  }

  // ── POST /api/v1/transactions ─────────────────────────────────────────────
  if (req.method === 'POST') {
    const { amount, type, description, date, categoryId } = req.body
    if (!amount || !type || !date || !categoryId) return badRequest(res, 'Campos obrigatórios faltando.')
    if (!['INCOME', 'EXPENSE'].includes(type)) return badRequest(res, 'Tipo inválido.')

    const limits = getLimits(session.plan ?? 'FREE')
    if (limits.transactionsPerMonth !== null) {
      // Bug 6 fix: atomic count + create prevents race condition on limit
      const now   = new Date()
      const start = new Date(now.getFullYear(), now.getMonth(), 1)
      const end   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)
      const created_tx = await db.$transaction(async (prisma) => {
        const count = await prisma.transaction.count({ where: { userId: session.userId, date: { gte: start, lte: end } } })
        if (count >= limits.transactionsPerMonth!) return null
        return prisma.transaction.create({
          data: { amount: parseFloat(amount), type, description: description ?? '', date: parseISO(date), userId: session.userId, categoryId },
          include: { category: { select: { id: true, name: true, icon: true, color: true } } },
        })
      })
      if (!created_tx) return planLimit(res, `Limite de ${limits.transactionsPerMonth} transações por mês atingido. Faça upgrade para o plano PRO.`)
      checkAchievements(db, session.userId, 'create-transaction').catch(() => {})
      return created(res, created_tx)
    }

    const tx = await db.transaction.create({
      data: { amount: parseFloat(amount), type, description: description ?? '', date: parseISO(date), userId: session.userId, categoryId },
      include: { category: { select: { id: true, name: true, icon: true, color: true } } },
    })
    checkAchievements(db, session.userId, 'create-transaction').catch(() => {})
    return created(res, tx)
  }

  return res.status(405).end()
})
