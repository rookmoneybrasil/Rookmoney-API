import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { getSubscription } from '@/lib/stripe'
import { ok, badRequest } from '@/lib/respond'

export default withAuth(async (req, res, session) => {
  if (req.method !== 'POST') return res.status(405).end()

  const user = await db.user.findUnique({
    where:  { id: session.userId },
    select: { stripeSubscriptionId: true },
  })

  if (!user?.stripeSubscriptionId) {
    return badRequest(res, 'Nenhuma assinatura Stripe encontrada.')
  }

  const sub = await getSubscription(user.stripeSubscriptionId)
  if (!sub) {
    return badRequest(res, 'Não foi possível consultar o Stripe.')
  }

  const periodEnd = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end
  const cancelAtPeriodEnd = sub.cancel_at_period_end || sub.cancel_at !== null
  const currentPeriodEnd = sub.cancel_at ? new Date(sub.cancel_at * 1000) : periodEnd ? new Date(periodEnd * 1000) : null

  await db.user.update({
    where: { id: session.userId },
    data:  { stripeCancelAtPeriodEnd: cancelAtPeriodEnd, stripeCurrentPeriodEnd: currentPeriodEnd },
  })

  return ok(res, {
    cancelAtPeriodEnd,
    currentPeriodEnd: currentPeriodEnd?.toISOString() ?? null,
    stripeStatus: sub.status,
  })
})
