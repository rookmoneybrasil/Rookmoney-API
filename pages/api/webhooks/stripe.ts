import type { NextApiRequest, NextApiResponse } from 'next'
import Stripe from 'stripe'
import { db } from '@/lib/db'
import { sendMetaEvent } from '@/lib/meta-capi'
import { sendUpgradeEmail, sendDowngradeEmail } from '@/lib/email'
import { planFromPriceId } from '@/lib/stripe'

export const config = { api: { bodyParser: false } }

async function readRawBody(req: NextApiRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end',  () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) return res.status(500).json({ error: 'Webhook not configured' })

  const rawBody   = await readRawBody(req)
  const sigHeader = (req.headers['stripe-signature'] as string) ?? ''

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', { apiVersion: '2025-04-30.basil' as never })

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(rawBody, sigHeader, secret)
  } catch (err) {
    console.error('[webhook] constructEvent failed:', err)
    return res.status(400).json({ error: 'Invalid signature' })
  }

  if (event.type === 'checkout.session.completed') {
    const session        = event.data.object as Stripe.Checkout.Session
    const userId         = session.metadata?.['userId']
    const customerId     = typeof session.customer === 'string' ? session.customer : null
    const subscriptionId = typeof session.subscription === 'string' ? session.subscription : null
    if (userId) {
      // Detect plan from the subscription's price ID
      let detectedPlan: 'PRO' | 'PRO_PLUS' = 'PRO'
      if (subscriptionId) {
        try {
          const subData = await stripe.subscriptions.retrieve(subscriptionId)
          const priceId = subData.items?.data?.[0]?.price?.id
          if (priceId) detectedPlan = planFromPriceId(priceId)
        } catch { /* fallback to PRO */ }
      }

      const value = detectedPlan === 'PRO_PLUS' ? 34.90 : 19.90
      const user = await db.user.update({
        where: { id: userId },
        data:  {
          plan:                       detectedPlan,
          stripeCustomerId:           customerId ?? undefined,
          stripeSubscriptionId:       subscriptionId ?? undefined,
          stripeCancelAtPeriodEnd:    false,
          stripeCurrentPeriodEnd:     null,
          subscriptionSource:         'stripe',
          googlePlayToken:            null,
          googlePlayOrderId:          null,
          appleOriginalTransactionId: null,
        },
        select: { email: true, name: true },
      })
      await db.adminLog.create({ data: {
        action: 'stripe_upgrade', targetId: userId,
        details: `Upgrade para ${detectedPlan} via Stripe (${user.email})`,
      }})

      sendMetaEvent({
        eventName: 'Subscribe',
        eventId:   `sub_${userId}_${Date.now()}`,
        sourceUrl: 'https://rookmoney.com/billing',
        userData:  { email: user.email },
        value,
        currency:  'BRL',
      }).catch(() => {})

      sendUpgradeEmail(user.email, user.name, detectedPlan).catch(() => {})
    }
  }

  if (event.type === 'customer.subscription.updated') {
    const sub        = event.data.object as Stripe.Subscription
    const customerId = typeof sub.customer === 'string' ? sub.customer : null
    if (customerId) {
      const user = await db.user.findFirst({ where: { stripeCustomerId: customerId }, select: { id: true, email: true, subscriptionSource: true } })
      // Ignore events for users who switched to Google Play or Apple — their Stripe sub is stale
      if (!user || (user.subscriptionSource !== 'stripe' && user.subscriptionSource !== null)) {
        // still return 200 below
      } else {
        const periodEnd = sub.items?.data?.[0]?.current_period_end
        const isCanceling = sub.cancel_at_period_end || (sub.cancel_at != null)
        const cancelDate = sub.cancel_at ? new Date(sub.cancel_at * 1000) : periodEnd ? new Date(periodEnd * 1000) : null
        await db.user.updateMany({
          where: { stripeCustomerId: customerId },
          data:  {
            stripeCancelAtPeriodEnd: isCanceling,
            ...(cancelDate && { stripeCurrentPeriodEnd: cancelDate }),
          },
        })
        const action = isCanceling ? 'stripe_cancel_scheduled' : 'stripe_cancel_reversed'
        const details = isCanceling
          ? `Cancelamento agendado via Stripe — acesso até ${cancelDate ? cancelDate.toLocaleDateString('pt-BR') : '?'} (${user.email})`
          : `Cancelamento revertido via Stripe — assinatura reativada (${user.email})`
        await db.adminLog.create({ data: { action, targetId: user.id, details } })
      }
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub        = event.data.object as Stripe.Subscription
    const customerId = typeof sub.customer === 'string' ? sub.customer : null
    if (customerId) {
      const user = await db.user.findFirst({ where: { stripeCustomerId: customerId }, select: { id: true, email: true, name: true, plan: true, proPlanExpiresAt: true, subscriptionSource: true } })
      const hasManualPlan     = user?.proPlanExpiresAt && new Date(user.proPlanExpiresAt) > new Date()
      const hasNonStripePlan  = user?.subscriptionSource === 'google_play' || user?.subscriptionSource === 'apple'

      if (hasManualPlan || hasNonStripePlan) {
        // Just clear stale Stripe fields — don't touch the plan
        await db.user.updateMany({
          where: { stripeCustomerId: customerId },
          data:  {
            stripeSubscriptionId:    null,
            stripeCancelAtPeriodEnd: false,
            stripeCurrentPeriodEnd:  null,
          },
        })
        if (user) {
          const reason = hasNonStripePlan
            ? `${user.subscriptionSource} ativo — plano mantido`
            : `plano manual ativo até ${new Date(user.proPlanExpiresAt!).toLocaleDateString('pt-BR')}`
          await db.adminLog.create({ data: {
            action: 'stripe_downgrade', targetId: user.id,
            details: `Assinatura Stripe encerrada — ${reason} (${user.email})`,
          }})
        }
      } else {
        const previousPlan = user?.plan ?? 'PRO'
        await db.user.updateMany({
          where: { stripeCustomerId: customerId },
          data:  {
            plan:                    'FREE',
            stripeSubscriptionId:    null,
            stripeCancelAtPeriodEnd: false,
            stripeCurrentPeriodEnd:  null,
            subscriptionSource:      null,
          },
        })
        if (user) {
          await db.adminLog.create({ data: {
            action: 'stripe_downgrade', targetId: user.id,
            details: `Downgrade para FREE — assinatura Stripe encerrada (${user.email})`,
          }})
          sendDowngradeEmail(user.email, user.name, previousPlan).catch(() => {})
        }
      }
    }
  }

  if (event.type === 'invoice.payment_failed') {
    const invoice    = event.data.object as Stripe.Invoice
    const customerId = typeof invoice.customer === 'string' ? invoice.customer : null
    if (customerId) {
      const user = await db.user.findFirst({
        where:  { stripeCustomerId: customerId },
        select: { email: true, name: true },
      })
      if (user) {
        const { sendPaymentFailedEmail } = await import('@/lib/email')
        await sendPaymentFailedEmail(user.email, user.name).catch(() => {})
        const target = await db.user.findFirst({ where: { stripeCustomerId: customerId }, select: { id: true } })
        if (target) {
          await db.adminLog.create({ data: {
            action: 'stripe_payment_failed', targetId: target.id,
            details: `Falha no pagamento Stripe — email de aviso enviado (${user.email})`,
          }})
        }
      }
    }
  }

  return res.status(200).json({ received: true })
}
