import type { NextApiRequest, NextApiResponse } from 'next'
import { SignJWT } from 'jose'
import { serialize } from 'cookie'
import bcrypt from 'bcryptjs'
import { rateLimit, getIp, tooManyRequests } from '@/lib/rate-limit'
import { db } from '@/lib/db'

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET ?? 'rook-dev-secret')

function setCORS(req: NextApiRequest, res: NextApiResponse) {
  const allowed = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3010,http://localhost:3020').split(',').map(o => o.trim())
  const origin  = req.headers.origin as string | undefined
  const allow   = (origin && allowed.includes(origin)) ? origin : ''
  res.setHeader('Access-Control-Allow-Origin',      allow)
  res.setHeader('Access-Control-Allow-Methods',     'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers',     'Content-Type')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Vary', 'Origin')
}

async function issueToken(res: NextApiResponse, claims: { adminRole: string; adminEmail: string }) {
  const token = await new SignJWT({ admin: true, role: 'backoffice', ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('12h')
    .setIssuedAt()
    .sign(SECRET)

  res.setHeader('Set-Cookie', serialize('rook_backoffice', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   60 * 60 * 12,
    path:     '/',
  }))
  return token
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  setCORS(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).end()

  // Rate limit: 5 attempts per IP per 15 minutes
  const ip = getIp(req)
  const rl  = await rateLimit(`admin-login:${ip}`, 5, 15 * 60 * 1000)
  if (!rl.allowed) return tooManyRequests(res, rl.resetAt)

  const { email, password, secret } = req.body as { email?: string; password?: string; secret?: string }

  // ── Mode 1: admin account (email + password) ──
  if (email && password) {
    const admin = await db.adminUser.findUnique({ where: { email: email.toLowerCase().trim() } })
    const valid = admin && admin.active && await bcrypt.compare(password, admin.passwordHash)
    if (!valid) {
      await new Promise(r => setTimeout(r, 800))
      return res.status(401).json({ ok: false, error: 'Email ou senha incorretos' })
    }
    await db.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } }).catch(() => {})
    const token = await issueToken(res, { adminRole: admin.role, adminEmail: admin.email })
    return res.status(200).json({ ok: true, token, role: admin.role, email: admin.email, name: admin.name })
  }

  // ── Mode 2: break-glass shared secret (always superadmin) ──
  const adminSecret = process.env.ADMIN_SECRET
  if (!adminSecret) return res.status(500).json({ ok: false, error: 'ADMIN_SECRET não configurado' })
  if (!secret || secret !== adminSecret) {
    await new Promise(r => setTimeout(r, 800))
    return res.status(401).json({ ok: false, error: 'Senha incorreta' })
  }

  const token = await issueToken(res, { adminRole: 'superadmin', adminEmail: 'break-glass' })
  return res.status(200).json({ ok: true, token, role: 'superadmin', email: 'break-glass' })
}
