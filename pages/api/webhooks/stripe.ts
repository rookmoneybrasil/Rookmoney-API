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
      const user = await db.user.update({
        where: { id: userId },
        data:  {
          plan: 'PRO',
          stripeCustomerId: customerId ?? undefined,
          stripeSubscriptionId: subscriptionId ?? undefined,
          stripeCancelAtPeriodEnd: false,
          stripeCurrentPeriodEnd: null,
        },
        select: { email: true },
      })
      await db.adminLog.create({ data: {
        action: 'stripe_upgrade', targetId: userId,
        details: `Upgrade para PRO via Stripe (${user.email})`,
      }})
    }
  }

  if (event.type === 'customer.subscription.updated') {
    const sub        = event.data.object as Stripe.Subscription
    const customerId = typeof sub.customer === 'string' ? sub.customer : null
    if (customerId) {
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
      const user = await db.user.findFirst({ where: { stripeCustomerId: customerId }, select: { id: true, email: true } })
      if (user) {
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
      const user = await db.user.findFirst({ where: { stripeCustomerId: customerId }, select: { id: true, email: true } })
      await db.user.updateMany({
        where: { stripeCustomerId: customerId },
        data:  {
          plan: 'FREE',
          stripeSubscriptionId: null,
          stripeCancelAtPeriodEnd: false,
          stripeCurrentPeriodEnd: null,
        },
      })
      if (user) {
        await db.adminLog.create({ data: {
          action: 'stripe_downgrade', targetId: user.id,
          details: `Downgrade para FREE — assinatura Stripe encerrada (${user.email})`,
        }})
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
