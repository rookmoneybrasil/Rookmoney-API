/**
 * Persistent rate limiting via PostgreSQL.
 * Replaces the in-memory Map which reset on every deploy.
 */

import type { NextApiRequest } from 'next'
import { db } from './db'

export interface RateLimitResult {
  allowed:   boolean
  remaining: number
  resetAt:   number
}

export async function rateLimit(
  key:        string,
  maxAttempts = 5,
  windowMs    = 15 * 60 * 1000,
): Promise<RateLimitResult> {
  const now     = new Date()
  const resetAt = new Date(Date.now() + windowMs)

  const existing = await db.rateLimit.findUnique({ where: { id: key } })

  if (!existing || existing.resetAt < now) {
    await db.rateLimit.upsert({
      where:  { id: key },
      update: { count: 1, resetAt },
      create: { id: key, count: 1, resetAt },
    })
    return { allowed: true, remaining: maxAttempts - 1, resetAt: resetAt.getTime() }
  }

  if (existing.count >= maxAttempts) {
    return { allowed: false, remaining: 0, resetAt: existing.resetAt.getTime() }
  }

  await db.rateLimit.update({ where: { id: key }, data: { count: { increment: 1 } } })
  return {
    allowed:   true,
    remaining: maxAttempts - existing.count - 1,
    resetAt:   existing.resetAt.getTime(),
  }
}

export async function resetLimit(key: string) {
  await db.rateLimit.deleteMany({ where: { id: key } }).catch(() => {})
}

export function getIp(req: NextApiRequest): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim()
  return req.socket?.remoteAddress ?? 'unknown'
}

export function tooManyRequests(res: Parameters<typeof import('./respond').badRequest>[0], resetAt: number) {
  const secs = Math.ceil((resetAt - Date.now()) / 1000)
  res.setHeader('Retry-After', String(secs))
  return res.status(429).json({
    ok:    false,
    error: `Muitas tentativas. Aguarde ${Math.ceil(secs / 60)} minuto(s) antes de tentar novamente.`,
    code:  'RATE_LIMITED',
  })
}

export async function cleanupExpiredLimits() {
  await db.rateLimit.deleteMany({ where: { resetAt: { lt: new Date() } } })
}
