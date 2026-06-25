import type { NextApiRequest, NextApiResponse } from 'next'
import { db } from '@/lib/db'
import {
  verifySubscription,
  planFromProductId,
  isSubscriptionActive,
} from '@/lib/google-play'

// Google RTDN notification types
const SUBSCRIPTION_RECOVERED = 1
const SUBSCRIPTION_RENEWED = 2
const SUBSCRIPTION_CANCELED = 3
const SUBSCRIPTION_PURCHASED = 4
const SUBSCRIPTION_ON_HOLD = 5
const SUBSCRIPTION_IN_GRACE_PERIOD = 6
const SUBSCRIPTION_RESTARTED = 7
const SUBSCRIPTION_REVOKED = 12
const SUBSCRIPTION_EXPIRED = 13

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const secret = process.env.GOOGLE_PLAY_WEBHOOK_SECRET
  if (secret && req.query.secret !== secret) {
    return res.status(403).json({ error: 'Invalid secret' })
  }

  try {
    const message = req.body?.message
    if (!message?.data) return res.status(200).json({ ok: true })

    const decoded = JSON.parse(Buffer.from(message.data, 'base64').toString())
    const notification = decoded.subscriptionNotification
    if (!notification) return res.status(200).json({ ok: true })

    const { notificationType, purchaseToken, subscriptionId } = notification
    const productId = subscriptionId as string

    const user = await db.user.findFirst({
      where: { googlePlayToken: purchaseToken },
      select: { id: true, email: true, plan: true },
    })

    if (!user) {
      console.warn('[google-play-webhook] No user found for token:', purchaseToken?.slice(0, 20))
      return res.status(200).json({ ok: true })
    }

    if ([SUBSCRIPTION_RECOVERED, SUBSCRIPTION_RENEWED, SUBSCRIPTION_RESTARTED].includes(notificationType)) {
      const plan = planFromProductId(productId)
      await db.user.update({
        where: { id: user.id },
        data: { plan, subscriptionSource: 'google_play' },
      })
      await db.adminLog.create({
        data: {
          action: 'google_play_renewed',
          targetId: user.id,
          details: `Assinatura Google Play renovada — ${plan} (${user.email})`,
        },
      })
    }

    if (notificationType === SUBSCRIPTION_CANCELED) {
      await db.adminLog.create({
        data: {
          action: 'google_play_cancel_scheduled',
          targetId: user.id,
          details: `Cancelamento Google Play agendado (${user.email})`,
        },
      })
    }

    if ([SUBSCRIPTION_REVOKED, SUBSCRIPTION_EXPIRED].includes(notificationType)) {
      await db.user.update({
        where: { id: user.id },
        data: {
          plan: 'FREE',
          googlePlayToken: null,
          googlePlayOrderId: null,
          subscriptionSource: null,
        },
      })
      await db.adminLog.create({
        data: {
          action: 'google_play_downgrade',
          targetId: user.id,
          details: `Downgrade para FREE — assinatura Google Play encerrada (${user.email})`,
        },
      })
    }

    if ([SUBSCRIPTION_ON_HOLD, SUBSCRIPTION_IN_GRACE_PERIOD].includes(notificationType)) {
      await db.adminLog.create({
        data: {
          action: 'google_play_payment_issue',
          targetId: user.id,
          details: `Problema de pagamento Google Play — ${notificationType === SUBSCRIPTION_ON_HOLD ? 'em espera' : 'período de graça'} (${user.email})`,
        },
      })
    }

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[google-play-webhook] error:', err)
    return res.status(200).json({ ok: true })
  }
}
