import { withAuth } from '@/lib/middleware'
import { ok, badRequest, serverError } from '@/lib/respond'
import { db } from '@/lib/db'
import {
  verifySubscription,
  acknowledgeSubscription,
  planFromProductId,
  isSubscriptionActive,
} from '@/lib/google-play'
import { sendMetaEvent } from '@/lib/meta-capi'

export default withAuth(async (req, res, session) => {
  if (req.method !== 'POST') return res.status(405).end()

  const { productId, purchaseToken } = req.body ?? {}
  if (!productId || !purchaseToken) {
    return badRequest(res, 'productId e purchaseToken são obrigatórios')
  }

  try {
    const sub = await verifySubscription(productId, purchaseToken)

    if (!isSubscriptionActive(sub)) {
      return badRequest(res, 'Assinatura inválida ou expirada')
    }

    const plan = planFromProductId(productId)

    if (sub.acknowledgementState === 0) {
      await acknowledgeSubscription(productId, purchaseToken)
    }

    const user = await db.user.update({
      where: { id: session.userId },
      data: {
        plan,
        googlePlayToken: purchaseToken,
        googlePlayOrderId: sub.orderId,
        subscriptionSource: 'google_play',
        stripeCancelAtPeriodEnd: false,
        stripeCurrentPeriodEnd: null,
      },
      select: { email: true },
    })

    await db.adminLog.create({
      data: {
        action: 'google_play_upgrade',
        targetId: session.userId,
        details: `Upgrade para ${plan} via Google Play — ${productId} (${user.email})`,
      },
    })

    const value = plan === 'PRO_PLUS' ? 34.90 : 19.90
    sendMetaEvent({
      eventName: 'Subscribe',
      eventId: `gp_${session.userId}_${Date.now()}`,
      sourceUrl: 'https://rookmoney.com/billing',
      userData: { email: user.email },
      value,
      currency: 'BRL',
    }).catch(() => {})

    return ok(res, {
      plan,
      expiresAt: new Date(parseInt(sub.expiryTimeMillis, 10)).toISOString(),
    })
  } catch (err) {
    console.error('[google-play] verification failed:', err)
    return serverError(res, err)
  }
}, ['POST'])
