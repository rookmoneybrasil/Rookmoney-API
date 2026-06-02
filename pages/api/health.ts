import type { NextApiRequest, NextApiResponse } from 'next'
import { db } from '@/lib/db'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const start = Date.now()
  try {
    await db.$queryRaw`SELECT 1`
    res.status(200).json({ ok: true, db: 'ok', latency: Date.now() - start })
  } catch (err) {
    console.error('[health] DB check failed:', err)
    res.status(503).json({ ok: false, db: 'error', latency: Date.now() - start })
  }
}
