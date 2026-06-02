import type { NextApiRequest, NextApiResponse } from 'next'
import { db } from '@/lib/db'
import { createHmac, timingSafeEqual } from 'crypto'

export const config = { api: { bodyParser: false } }

function verifyStripeSignature(payload: string, sigHeader: string, secret: string): boolean {
  try {
    // Use split with limit so values containing '=' are preserved
    const parts = sigHeader.split(',').reduce<Record<string, string>>((acc, part) => {
      const idx = part.indexOf('=')
      if (idx === -1) return acc
      acc[part.slice(0, idx)] = part.slice(idx + 1)
      return acc
    }, {})
    const { t: timestamp, v1: signature } = parts
    if (!timestamp || !signature) {
      console.error('[webhook] Missing t or v1 in sig header:', JSON.stringify(parts))
      return false
    }
    const expected    = createHmac('sha256', secret).update(`${timestamp}.${payload}`, 'utf8').digest('hex')
    const expectedBuf = Buffer.from(expected, 'hex')
    const actualBuf   = Buffer.from(signature, 'hex')
    if (expectedBuf.length !== actualBuf.length) {
      console.error('[webhook] Signature length mismatch:', expectedBuf.length, actualBuf.length)
      return false
    }
    return timingSafeEqual(expectedBuf, actualBuf)
  } catch (e) {
    console.error('[webhook] Signature verification threw:', e)
    return false
  }
}

async function readRawBody(req: NextApiRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => { body += chunk.toString() })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) return res.status(500).json({ error: 'Webhook not configured' })

  const rawBody   = await readRawBody(req)
  const sigHeader = (req.headers['stripe-signature'] as string) ?? ''

  console.log('[webhook] secret length:', secret?.length, 'sig header prefix:', sigHeader?.slice(0, 30))
  if (!verifyStripeSignature(rawBody, sigHeader, secret)) {
    console.error('[webhook] Invalid signature — check STRIPE_WEBHOOK_SECRET matches Stripe dashboard')
    return res.status(400).json({ error: 'Invalid signature' })
  }

  let event: { type: string; data: { object: Record<string, unknown> } }
  try { event = JSON.parse(rawBody) }
  catch { return res.status(400).json({ error: 'Invalid JSON' }) }

  const obj = event.data.object

  if (event.type === 'checkout.session.completed') {
    const userId       = (obj['metadata'] as Record<string, string>)?.['userId']
    const customerId   = obj['customer'] as string | null
    const subscriptionId = obj['subscription'] as string | null
    if (userId) {
      await db.user.update({
        where: { id: userId },
        data:  { plan: 'PRO', stripeCustomerId: customerId ?? undefined, stripeSubscriptionId: subscriptionId ?? undefined },
      })
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const customerId = obj['customer'] as string | null
    if (customerId) {
      await db.user.updateMany({ where: { stripeCustomerId: customerId }, data: { plan: 'FREE', stripeSubscriptionId: null } })
    }
  }

  return res.status(200).json({ received: true })
}
