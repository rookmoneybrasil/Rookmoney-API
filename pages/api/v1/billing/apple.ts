import { withAuth } from '@/lib/middleware'
import { ok, badRequest, serverError } from '@/lib/respond'
import { db } from '@/lib/db'
import { verifyAppleSignedTransaction, planFromAppleProductId } from '@/lib/apple-iap'
import { sendMetaEvent } from '@/lib/meta-capi'

const BUNDLE_ID = 'com.rookmoney.app'

export default withAuth(async (req, res, session) => {
  if (req.method !== 'POST') return res.status(405).end()

  const { jwsTransaction } = req.body ?? {}
  if (!jwsTransaction || typeof jwsTransaction !== 'string') {
    return badRequest(res, 'jwsTransaction obrigatório')
  }

  try {
    const txn = await verifyAppleSignedTransaction(jwsTransaction)

    if (txn.bundleId !== BUNDLE_ID) {
      return badRequest(res, `Bundle ID inválido: ${txn.bundleId}`)
    }

    if (txn.expiresDate && txn.expiresDate < Date.now()) {
      return badRequest(res, 'Assinatura expirada')
    }

    const plan = planFromAppleProductId(txn.productId)

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
        console.error('[apple-iap] Stripe cancel on mobile upgrade:', err instanceof Error ? err.message : err)
      }
    }

    const user = await db.user.update({
      where: { id: session.userId },
      data: {
        plan,
        appleOriginalTransactionId: txn.originalTransactionId,
        subscriptionSource:         'apple',
        stripeSubscriptionId:       null,
        stripeCancelAtPeriodEnd:    false,
        stripeCurrentPeriodEnd:     null,
        googlePlayToken:            null,
        googlePlayOrderId:          null,
      },
      select: { email: true },
    })

    await db.adminLog.create({
      data: {
        action:   'apple_iap_upgrade',
        targetId: session.userId,
        details:  `Upgrade para ${plan} via Apple IAP — ${txn.productId} (${user.email})`,
      },
    })

    const value = plan === 'PRO_PLUS' ? 34.90 : 19.90
    sendMetaEvent({
      eventName: 'Subscribe',
      eventId:   `apple_${session.userId}_${txn.transactionId}`,
      sourceUrl: 'https://rookmoney.com/billing',
      userData:  { email: user.email },
      value,
      currency:  'BRL',
    }).catch(() => {})

    return ok(res, {
      plan,
      expiresAt: txn.expiresDate ? new Date(txn.expiresDate).toISOString() : null,
    })
  } catch (err) {
    console.error('[apple-iap] verification failed:', err)
    return serverError(res, err)
  }
}, ['POST'])
