import type { NextApiRequest, NextApiResponse } from 'next'
import Stripe from 'stripe'
import { db } from '@/lib/db'

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
      await db.user.update({
        where: { id: userId },
        data:  {
          plan: 'PRO',
          stripeCustomerId: customerId ?? undefined,
          stripeSubscriptionId: subscriptionId ?? undefined,
          stripeCancelAtPeriodEnd: false,
          stripeCurrentPeriodEnd: null,
        },
      })
    }
  }

  if (event.type === 'customer.subscription.updated') {
    const sub        = event.data.object as Stripe.Subscription
    const customerId = typeof sub.customer === 'string' ? sub.customer : null
    if (customerId) {
      const periodEnd = sub.items?.data?.[0]?.current_period_end
      await db.user.updateMany({
        where: { stripeCustomerId: customerId },
        data:  {
          stripeCancelAtPeriodEnd: sub.cancel_at_period_end,
          ...(periodEnd && { stripeCurrentPeriodEnd: new Date(periodEnd * 1000) }),
        },
      })
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub        = event.data.object as Stripe.Subscription
    const customerId = typeof sub.customer === 'string' ? sub.customer : null
    if (customerId) {
      await db.user.updateMany({
        where: { stripeCustomerId: customerId },
        data:  {
          plan: 'FREE',
          stripeSubscriptionId: null,
          stripeCancelAtPeriodEnd: false,
          stripeCurrentPeriodEnd: null,
        },
      })
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
      }
    }
  }

  return res.status(200).json({ received: true })
}
