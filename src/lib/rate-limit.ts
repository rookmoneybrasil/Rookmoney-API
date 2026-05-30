import type { NextApiRequest } from 'next'

interface RateLimitEntry {
  count:   number
  resetAt: number
}

const store = new Map<string, RateLimitEntry>()

// Clean up expired entries periodically
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of store.entries()) {
    if (now > entry.resetAt) store.delete(key)
  }
}, 60_000)

export interface RateLimitResult {
  allowed:   boolean
  remaining: number
  resetAt:   number
}

export function rateLimit(
  key:        string,
  maxAttempts = 5,
  windowMs    = 15 * 60 * 1000,
): RateLimitResult {
  const now   = Date.now()
  const entry = store.get(key)

  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs })
    return { allowed: true, remaining: maxAttempts - 1, resetAt: now + windowMs }
  }

  if (entry.count >= maxAttempts) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt }
  }

  entry.count++
  return { allowed: true, remaining: maxAttempts - entry.count, resetAt: entry.resetAt }
}

export function resetLimit(key: string) {
  store.delete(key)
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
