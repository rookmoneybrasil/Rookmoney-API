import type { PrismaClient } from '../generated/prisma/client'
import { getAchievementsByTrigger } from './achievements'

export interface UnlockedAchievement {
  slug: string
  icon: string
}

/**
 * Check & unlock achievements for a user after an action.
 * Returns newly unlocked achievements (for toast notifications).
 * Safe to call frequently — skips already-unlocked slugs.
 */
export async function checkAchievements(
  db:      PrismaClient,
  userId:  string,
  trigger: string,
  ctx:     Record<string, unknown> = {},
): Promise<UnlockedAchievement[]> {
  const candidates = getAchievementsByTrigger(trigger)
  if (candidates.length === 0) return []

  const existing = new Set(
    (await db.userAchievement.findMany({
      where:  { userId },
      select: { slug: true },
    })).map(a => a.slug)
  )

  const toCheck = candidates.filter(a => !existing.has(a.slug))
  if (toCheck.length === 0) return []

  const newlyUnlocked: UnlockedAchievement[] = []

  for (const achievement of toCheck) {
    const passed = await evaluateAchievement(db, userId, achievement.slug, ctx)
    if (passed) {
      await db.userAchievement.create({
        data: { userId, slug: achievement.slug },
      }).catch(() => {}) // ignore unique constraint race
      newlyUnlocked.push({ slug: achievement.slug, icon: achievement.icon })
    }
  }

  return newlyUnlocked
}

async function evaluateAchievement(
  db:     PrismaClient,
  userId: string,
  slug:   string,
  ctx:    Record<string, unknown>,
): Promise<boolean> {
  switch (slug) {
    // ─── Onboarding ────────────────────────────────────────────
    case 'welcome':
      return true // triggered on register

    case 'first-account':
    case 'first-transaction': {
      const count = await db.transaction.count({ where: { userId }, take: 1 })
      return count >= 1
    }

    case 'first-income': {
      const count = await db.incomeSource.count({ where: { userId }, take: 1 })
      return count >= 1
    }

    case 'first-bill': {
      const count = await db.bill.count({ where: { userId }, take: 1 })
      return count >= 1
    }

    case 'first-goal': {
      const count = await db.goal.count({ where: { userId }, take: 1 })
      return count >= 1
    }

    case 'complete-profile': {
      const user = await db.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, profileImage: true },
      })
      return !!(user?.name && user.email && user.profileImage)
    }

    // ─── Organization ──────────────────────────────────────────
    case 'organized': {
      const cats = await db.bill.findMany({
        where: { userId, categoryId: { not: null } },
        select: { categoryId: true },
        distinct: ['categoryId'],
      })
      return cats.length >= 3
    }

    case 'archivist': {
      const cats = await db.bill.findMany({
        where: { userId, categoryId: { not: null } },
        select: { categoryId: true },
        distinct: ['categoryId'],
      })
      return cats.length >= 7
    }

    case 'autopilot': {
      const count = await db.recurringBill.count({ where: { userId, isActive: true }, take: 1 })
      return count >= 1
    }

    case 'full-autopilot': {
      const count = await db.recurringBill.count({ where: { userId, isActive: true } })
      return count >= 10
    }

    case 'split-right': {
      const count = await db.personEntry.count({ where: { userId }, take: 1 })
      return count >= 1
    }

    case 'financial-network': {
      const people = await db.person.findMany({
        where: { userId },
        select: { id: true, _count: { select: { entries: true } } },
      })
      const withEntries = people.filter(p => p._count.entries > 0)
      return withEntries.length >= 5
    }

    case 'multi-income': {
      const count = await db.incomeSource.count({ where: { userId } })
      return count >= 3
    }

    case 'diversified': {
      const count = await db.incomeSource.count({ where: { userId } })
      return count >= 5
    }

    case 'full-panorama': {
      const [bills, goals, income, tx] = await Promise.all([
        db.bill.count({ where: { userId }, take: 1 }),
        db.goal.count({ where: { userId }, take: 1 }),
        db.incomeSource.count({ where: { userId }, take: 1 }),
        db.transaction.count({ where: { userId }, take: 1 }),
      ])
      return bills >= 1 && goals >= 1 && income >= 1 && tx >= 1
    }

    // ─── Payments & Discipline ─────────────────────────────────
    case 'punctual':
    case 'super-punctual':
    case 'relentless':
    case 'punctuality-legend': {
      const thresholds: Record<string, number> = {
        'punctual': 5, 'super-punctual': 25, 'relentless': 100, 'punctuality-legend': 500,
      }
      const count = await db.bill.count({
        where: { userId, isPaid: true, paidAt: { not: null }, dueDate: { gte: new Date(0) } },
      })
      // Count bills paid on or before due date
      const onTime = await db.$queryRawUnsafe<[{ count: bigint }]>(
        `SELECT COUNT(*) as count FROM "Bill" WHERE "userId" = $1 AND "isPaid" = true AND "paidAt" IS NOT NULL AND "paidAt" <= "dueDate" + interval '1 day'`,
        userId,
      )
      return Number(onTime[0].count) >= thresholds[slug]
    }

    case 'clean-month': {
      // All bills in current month are paid
      const now = new Date()
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
      const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)
      const unpaid = await db.bill.count({
        where: { userId, isPaid: false, dueDate: { gte: monthStart, lte: monthEnd } },
      })
      const total = await db.bill.count({
        where: { userId, dueDate: { gte: monthStart, lte: monthEnd } },
      })
      return total > 0 && unpaid === 0
    }

    case 'perfect-quarter':
    case 'golden-semester':
    case 'flawless-year': {
      const months: Record<string, number> = { 'perfect-quarter': 3, 'golden-semester': 6, 'flawless-year': 12 }
      return await checkConsecutiveCleanMonths(db, userId, months[slug])
    }

    case 'cleared-month': {
      const now = new Date()
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
      const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)
      const overdue = await db.bill.count({
        where: { userId, isPaid: false, dueDate: { lt: now, gte: monthStart } },
      })
      return overdue === 0
    }

    case 'lightning-payer': {
      if (ctx.billId) {
        const bill = await db.bill.findUnique({ where: { id: ctx.billId as string } })
        if (bill?.isPaid && bill.paidAt && bill.createdAt) {
          const diff = new Date(bill.paidAt).getTime() - new Date(bill.createdAt).getTime()
          return diff < 24 * 60 * 60 * 1000 // same day
        }
      }
      // Fallback: check any bill
      const result = await db.$queryRawUnsafe<[{ count: bigint }]>(
        `SELECT COUNT(*) as count FROM "Bill" WHERE "userId" = $1 AND "isPaid" = true AND "paidAt" IS NOT NULL AND "paidAt"::date = "createdAt"::date`,
        userId,
      )
      return Number(result[0].count) >= 1
    }

    case 'ahead-of-time': {
      const result = await db.$queryRawUnsafe<[{ count: bigint }]>(
        `SELECT COUNT(*) as count FROM "Bill" WHERE "userId" = $1 AND "isPaid" = true AND "paidAt" IS NOT NULL AND "paidAt" <= "dueDate" - interval '7 days'`,
        userId,
      )
      return Number(result[0].count) >= 1
    }

    case 'fortune-teller': {
      const result = await db.$queryRawUnsafe<[{ count: bigint }]>(
        `SELECT COUNT(*) as count FROM "Bill" WHERE "userId" = $1 AND "isPaid" = true AND "paidAt" IS NOT NULL AND "paidAt" <= "dueDate" - interval '30 days'`,
        userId,
      )
      return Number(result[0].count) >= 1
    }

    // ─── Goals & Savings ───────────────────────────────────────
    case 'first-deposit': {
      const count = await db.goalContribution.count({
        where: { goal: { userId } },
        take: 1,
      })
      return count >= 1
    }

    case 'steady':
    case 'dedicated':
    case 'obsessive': {
      const thresholds: Record<string, number> = { 'steady': 5, 'dedicated': 20, 'obsessive': 50 }
      const count = await db.goalContribution.count({ where: { goal: { userId } } })
      return count >= thresholds[slug]
    }

    case 'halfway': {
      const goals = await db.goal.findMany({
        where: { userId },
        select: { targetAmount: true, currentAmount: true },
      })
      return goals.some(g => Number(g.currentAmount) >= Number(g.targetAmount) * 0.5 && Number(g.targetAmount) > 0)
    }

    case 'goal-reached': {
      const count = await db.goal.count({ where: { userId, isCompleted: true }, take: 1 })
      return count >= 1
    }

    case 'dream-collector':
    case 'achiever':
    case 'dream-machine': {
      const thresholds: Record<string, number> = { 'dream-collector': 3, 'achiever': 5, 'dream-machine': 10 }
      const count = await db.goal.count({ where: { userId, isCompleted: true } })
      return count >= thresholds[slug]
    }

    case 'heavy-deposit': {
      const big = await db.goalContribution.findFirst({
        where: { goal: { userId }, amount: { gte: 1000 } },
      })
      return !!big
    }

    case 'monster-deposit': {
      const big = await db.goalContribution.findFirst({
        where: { goal: { userId }, amount: { gte: 5000 } },
      })
      return !!big
    }

    case 'goal-millionaire': {
      const goals = await db.goal.findMany({
        where: { userId },
        select: { currentAmount: true },
      })
      const total = goals.reduce((sum, g) => sum + Number(g.currentAmount), 0)
      return total >= 10000
    }

    // ─── Volume & Engagement ───────────────────────────────────
    case '10-bills':
    case '50-bills':
    case '100-bills':
    case '500-bills': {
      const thresholds: Record<string, number> = { '10-bills': 10, '50-bills': 50, '100-bills': 100, '500-bills': 500 }
      const count = await db.bill.count({ where: { userId } })
      return count >= thresholds[slug]
    }

    case '50-transactions':
    case '200-transactions':
    case '500-transactions': {
      const thresholds: Record<string, number> = { '50-transactions': 50, '200-transactions': 200, '500-transactions': 500 }
      const count = await db.transaction.count({ where: { userId } })
      return count >= thresholds[slug]
    }

    case 'veteran':
    case 'rooted':
    case 'legendary':
    case 'eternal': {
      const months: Record<string, number> = { 'veteran': 3, 'rooted': 6, 'legendary': 12, 'eternal': 24 }
      const user = await db.user.findUnique({ where: { id: userId }, select: { createdAt: true } })
      if (!user) return false
      const diff = Date.now() - new Date(user.createdAt).getTime()
      return diff >= months[slug] * 30 * 24 * 60 * 60 * 1000
    }

    // ─── Financial Advanced ────────────────────────────────────
    case 'positive-balance': {
      return await checkMonthSurplus(db, userId, 1)
    }

    case 'surplus-3': return await checkMonthSurplus(db, userId, 3)
    case 'surplus-6': return await checkMonthSurplus(db, userId, 6)
    case 'balance-guardian': return await checkMonthSurplus(db, userId, 12)

    case 'economist': {
      return await checkSpendingRatio(db, userId, 0.8)
    }

    case 'frugal': {
      return await checkSpendingRatio(db, userId, 0.5)
    }

    case 'debt-free': {
      const unpaid = await db.bill.count({ where: { userId, isPaid: false } })
      return unpaid === 0
    }

    case 'big-payment': {
      const big = await db.bill.findFirst({
        where: { userId, isPaid: true, amount: { gte: 1000 } },
      })
      return !!big
    }

    case 'epic-payment': {
      const big = await db.bill.findFirst({
        where: { userId, isPaid: true, amount: { gte: 5000 } },
      })
      return !!big
    }

    case 'investor': {
      const count = await db.goal.count({ where: { userId, isCompleted: false } })
      return count >= 3
    }

    default:
      return false
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function checkConsecutiveCleanMonths(db: PrismaClient, userId: string, requiredMonths: number): Promise<boolean> {
  const now = new Date()
  for (let i = 0; i < requiredMonths; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const monthStart = new Date(d.getFullYear(), d.getMonth(), 1)
    const monthEnd   = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59)

    const total = await db.bill.count({
      where: { userId, dueDate: { gte: monthStart, lte: monthEnd } },
    })
    if (total === 0) continue // no bills = skip (not a failure)

    const unpaid = await db.bill.count({
      where: { userId, isPaid: false, dueDate: { gte: monthStart, lte: monthEnd } },
    })
    if (unpaid > 0) return false
  }
  return true
}

async function checkMonthSurplus(db: PrismaClient, userId: string, consecutiveMonths: number): Promise<boolean> {
  const now = new Date()
  for (let i = 0; i < consecutiveMonths; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const monthStart = new Date(d.getFullYear(), d.getMonth(), 1)
    const monthEnd   = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59)

    const [incomeAgg, expenseAgg] = await Promise.all([
      db.transaction.aggregate({
        where: { userId, type: 'INCOME', date: { gte: monthStart, lte: monthEnd } },
        _sum: { amount: true },
      }),
      db.transaction.aggregate({
        where: { userId, type: 'EXPENSE', date: { gte: monthStart, lte: monthEnd } },
        _sum: { amount: true },
      }),
    ])

    const income  = Number(incomeAgg._sum.amount ?? 0)
    const expense = Number(expenseAgg._sum.amount ?? 0)
    if (income <= 0 || expense >= income) return false
  }
  return true
}

async function checkSpendingRatio(db: PrismaClient, userId: string, maxRatio: number): Promise<boolean> {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)

  const [incomeAgg, expenseAgg] = await Promise.all([
    db.transaction.aggregate({
      where: { userId, type: 'INCOME', date: { gte: monthStart, lte: monthEnd } },
      _sum: { amount: true },
    }),
    db.transaction.aggregate({
      where: { userId, type: 'EXPENSE', date: { gte: monthStart, lte: monthEnd } },
      _sum: { amount: true },
    }),
  ])

  const income  = Number(incomeAgg._sum.amount ?? 0)
  const expense = Number(expenseAgg._sum.amount ?? 0)
  if (income <= 0) return false
  return expense / income < maxRatio
}
