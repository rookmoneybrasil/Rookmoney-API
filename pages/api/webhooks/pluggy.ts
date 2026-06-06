import type { NextApiRequest, NextApiResponse } from 'next'
import { db } from '@/lib/db'

// Pluggy sends webhooks for item lifecycle events.
// Must respond 2xx within 5 seconds.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  // Respond immediately — Pluggy requires 2xx within 5 seconds
  res.status(200).json({ received: true })

  try {
    const { event, itemId } = req.body as { event?: string; itemId?: string }
    if (!itemId) return

    switch (event) {
      case 'item/created':
      case 'item/updated':
        await db.pluggyItem.updateMany({
          where: { itemId },
          data:  { status: 'UPDATED', updatedAt: new Date() },
        })
        break

      case 'item/error':
        await db.pluggyItem.updateMany({
          where: { itemId },
          data:  { status: 'ERROR', updatedAt: new Date() },
        })
        break

      case 'item/waiting_user_input':
      case 'item/waiting_user_action':
        await db.pluggyItem.updateMany({
          where: { itemId },
          data:  { status: 'WAITING_USER_INPUT', updatedAt: new Date() },
        })
        break

      case 'item/deleted':
        await db.pluggyItem.deleteMany({ where: { itemId } })
        break

      case 'transactions/created':
      case 'transactions/updated':
        // Refresh lastSyncAt so the UI knows new data is available
        await db.pluggyItem.updateMany({
          where: { itemId },
          data:  { lastSyncAt: new Date(), updatedAt: new Date() },
        })
        break
    }
  } catch {
    // Errors are logged but don't affect the 200 already sent
    console.error('[Pluggy webhook] error processing event')
  }
}
