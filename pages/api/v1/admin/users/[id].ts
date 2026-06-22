import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, noContent, notFound, badRequest } from '@/lib/respond'

function calcExpiresAt(duration: string): Date | null {
  if (duration === 'lifetime') return null
  const now = new Date()
  if (duration === '3m')  return new Date(now.getFullYear(), now.getMonth() + 3,  now.getDate())
  if (duration === '6m')  return new Date(now.getFullYear(), now.getMonth() + 6,  now.getDate())
  if (duration === '12m') return new Date(now.getFullYear(), now.getMonth() + 12, now.getDate())
  return null
}

export default withBackofficeAuth(async (req, res) => {
  const id   = req.query.id as string
  const user = await db.user.findUnique({
    where: { id },
    select: {
      id: true, name: true, email: true, plan: true, isAdmin: true, createdAt: true, updatedAt: true,
      whatsappPhone: true, stripeCustomerId: true, stripeSubscriptionId: true,
      stripeCancelAtPeriodEnd: true, stripeCurrentPeriodEnd: true,
      proPlanExpiresAt: true, proPlanReason: true, adminNotes: true, lastActiveAt: true,
      googleId: true, hasOnboarded: true,
      profileImage: true, bio: true, city: true, occupation: true, birthdate: true,
      currency: true, dateFormat: true,
      notifBillReminder: true, notifCategoryLimit: true, notifMonthlyEmail: true,
      pushToken: true,
      chatUsageMonth: true, chatUsageCount: true, scannerUsageMonth: true, scannerUsageCount: true,
      _count: { select: { transactions: true, goals: true, bills: true, budgets: true, people: true, incomeSources: true, recurringBills: true } },
    },
  })
  if (!user) return notFound(res)

  if (user.stripeSubscriptionId) {
    try {
      const { getSubscription } = await import('@/lib/stripe')
      const sub = await getSubscription(user.stripeSubscriptionId)
      if (sub) {
        const periodEnd = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end
        user.stripeCancelAtPeriodEnd = sub.cancel_at_period_end ?? false
        user.stripeCurrentPeriodEnd = periodEnd ? new Date(periodEnd * 1000) : null
        await db.user.update({
          where: { id },
          data: { stripeCancelAtPeriodEnd: user.stripeCancelAtPeriodEnd, stripeCurrentPeriodEnd: user.stripeCurrentPeriodEnd },
        }).catch(() => {})
      }
    } catch { /* Stripe unavailable — use cached data */ }
  }

  if (req.method === 'GET') {
    const [recentTransactions, logs, firstTx, totalIncome, totalExpense] = await Promise.all([
      db.transaction.findMany({
        where: { userId: id }, orderBy: { date: 'desc' }, take: 10,
        include: { category: { select: { name: true, icon: true, color: true } } },
      }),
      db.adminLog.findMany({
        where: { targetId: id }, orderBy: { createdAt: 'desc' }, take: 20,
      }),
      db.transaction.findFirst({
        where: { userId: id }, orderBy: { date: 'asc' }, select: { date: true },
      }),
      db.transaction.aggregate({
        where: { userId: id, type: 'INCOME' }, _sum: { amount: true },
      }),
      db.transaction.aggregate({
        where: { userId: id, type: 'EXPENSE' }, _sum: { amount: true },
      }),
    ])

    const safeUser = {
      ...user,
      loginMethod: user.googleId ? 'google' as const : 'email' as const,
      hasMobileApp: !!user.pushToken,
      googleId: undefined,
      pushToken: undefined,
    }

    return ok(res, {
      user: safeUser,
      recentTransactions,
      logs,
      financialSummary: {
        firstTransactionDate: firstTx?.date ?? null,
        totalIncome: Number(totalIncome._sum.amount ?? 0),
        totalExpense: Number(totalExpense._sum.amount ?? 0),
      },
    })
  }

  if (req.method === 'PATCH') {
    const { plan, duration, reason, isAdmin, adminNotes } = req.body

    if (plan !== undefined) {
      if (plan === 'PRO') {
        if (!duration || !['3m', '6m', '12m', 'lifetime'].includes(duration)) {
          return badRequest(res, 'duration deve ser 3m, 6m, 12m ou lifetime')
        }
        if (!reason || !reason.trim()) {
          return badRequest(res, 'motivo é obrigatório ao dar PRO manual')
        }
        const expiresAt = calcExpiresAt(duration)
        await db.user.update({
          where: { id },
          data: { plan: 'PRO', proPlanExpiresAt: expiresAt, proPlanReason: reason.trim() },
        })
        const durationLabel = duration === 'lifetime' ? 'vitalício' : duration
        const expiryText    = expiresAt ? ` (expira ${expiresAt.toLocaleDateString('pt-BR')})` : ' (vitalício)'
        const verb          = user.plan === 'PRO' ? 'PRO prorrogado' : 'Plano PRO manual'
        await db.adminLog.create({ data: {
          action: 'plan_change', targetId: id,
          details: `${verb} ${durationLabel}${expiryText} — motivo: ${reason.trim()} (${user.email})`,
        }})
      } else if (plan === 'FREE') {
        await db.user.update({
          where: { id },
          data: { plan: 'FREE', proPlanExpiresAt: null, proPlanReason: null },
        })
        await db.adminLog.create({ data: {
          action: 'plan_change', targetId: id,
          details: `Plano alterado de ${user.plan} para FREE (${user.email})`,
        }})
      }
    }

    if (isAdmin !== undefined) {
      await db.user.update({ where: { id }, data: { isAdmin } })
      await db.adminLog.create({ data: {
        action: 'toggle_admin', targetId: id,
        details: `Admin ${isAdmin ? 'concedido' : 'removido'} de ${user.email}`,
      }})
    }

    if (adminNotes !== undefined) {
      await db.user.update({ where: { id }, data: { adminNotes: adminNotes || null } })
    }

    const updated = await db.user.findUnique({
      where: { id },
      select: { id: true, plan: true, isAdmin: true, proPlanExpiresAt: true, proPlanReason: true, adminNotes: true },
    })
    return ok(res, updated)
  }

  if (req.method === 'DELETE') {
    await db.adminLog.create({ data: { action: 'delete_user', targetId: id, details: `Conta deletada: ${user.email} (${user.name})` } })
    await db.user.delete({ where: { id } })
    return noContent(res)
  }

  return res.status(405).end()
})
