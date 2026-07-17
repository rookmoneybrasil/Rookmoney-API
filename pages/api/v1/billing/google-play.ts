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
import { runIntegrityGate, INTEGRITY_DENIED } from '@/lib/play-integrity'

export default withAuth(async (req, res, session) => {
  if (req.method !== 'POST') return res.status(405).end()

  const { productId, purchaseToken, integrityToken } = req.body ?? {}
  if (!productId || !purchaseToken) {
    return badRequest(res, 'productId e purchaseToken são obrigatórios')
  }

  // Play Integrity gate (Android) — second layer of defense. The app also checks
  // this before starting the purchase (POST /billing/integrity-check), so a
  // compromised device is normally stopped before being charged; this re-check
  // catches a client that skipped straight to verify. Same shared decision.
  const gate = await runIntegrityGate(integrityToken, session.userId)
  if (gate.log) {
    db.adminLog
      .create({ data: { action: 'integrity_check', targetId: session.userId, details: gate.log } })
      .catch(() => {})
  }
  if (!gate.allow) return res.status(403).json({ ok: false, ...INTEGRITY_DENIED })

  try {
    const sub = await verifySubscription(productId, purchaseToken)

    if (!isSubscriptionActive(sub)) {
      return badRequest(res, 'Assinatura inválida ou expirada')
    }

    const plan = planFromProductId(productId)

    if (sub.acknowledgementState === 0) {
      await acknowledgeSubscription(productId, purchaseToken)
    }

    // Cancel active Stripe subscription to prevent double-charging
    const existing = await db.user.findUnique({
      where:  { id: session.userId },
      select: { stripeSubscriptionId: true },
    })
    if (existing?.stripeSubscriptionId) {
      try {
        const { cancelSubscription } = await import('@/lib/stripe')
        await cancelSubscription(existing.stripeSubscriptionId)
      } catch (err) {
        console.error('[google-play] Stripe cancel on mobile upgrade:', err instanceof Error ? err.message : err)
      }
    }

    const user = await db.user.update({
      where: { id: session.userId },
      data: {
        plan,
        googlePlayToken:            purchaseToken,
        googlePlayOrderId:          sub.orderId,
        subscriptionSource:         'google_play',
        stripeSubscriptionId:       null,
        stripeCancelAtPeriodEnd:    false,
        stripeCurrentPeriodEnd:     null,
        appleOriginalTransactionId: null,
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
