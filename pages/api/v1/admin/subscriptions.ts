import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'
import { listActiveSubscriptions } from '@/lib/stripe'

export default withBackofficeAuth(async (_req, res) => {
  let stripeSubs: Awaited<ReturnType<typeof listActiveSubscriptions>> = []
  try {
    stripeSubs = await listActiveSubscriptions()
  } catch {
    // If Stripe is not configured or fails, return PRO users without renewal date
  }

  const proUsers = await db.user.findMany({
    where:   { plan: 'PRO' },
    orderBy: { createdAt: 'desc' },
    select:  { id: true, name: true, email: true, createdAt: true,
      stripeCustomerId: true, stripeSubscriptionId: true,
      proPlanExpiresAt: true, proPlanReason: true },
  })

  // Build a map from Stripe customerId → subscription details
  const subByCustomer = new Map(stripeSubs.map(s => [s.customer, s]))

  const data = proUsers.map(u => {
    const sub = u.stripeCustomerId ? subByCustomer.get(u.stripeCustomerId) : undefined
    return {
      id:              u.id,
      name:            u.name,
      email:           u.email,
      createdAt:       u.createdAt,
      stripeSubId:     u.stripeSubscriptionId,
      renewalDate:     sub ? new Date(sub.current_period_end * 1000).toISOString() : null,
      cancelAtPeriodEnd: sub?.cancel_at_period_end ?? false,
      hasStripe:       !!u.stripeSubscriptionId,
      proPlanExpiresAt: u.proPlanExpiresAt,
      proPlanReason:    u.proPlanReason,
    }
  })

  return ok(res, { subscriptions: data, total: data.length })
}, ['GET'])
