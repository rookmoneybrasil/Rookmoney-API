import type { NextApiRequest, NextApiResponse } from 'next'
import { SignJWT } from 'jose'
import { serialize } from 'cookie'

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET ?? 'rook-dev-secret')

function setCORS(req: NextApiRequest, res: NextApiResponse) {
  const allowed = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3010,http://localhost:3020').split(',').map(o => o.trim())
  const origin  = req.headers.origin as string | undefined
  const allow   = (origin && allowed.includes(origin)) ? origin : allowed[0]
  res.setHeader('Access-Control-Allow-Origin',      allow)
  res.setHeader('Access-Control-Allow-Methods',     'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers',     'Content-Type')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Vary', 'Origin')
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  setCORS(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).end()

  const { secret } = req.body as { secret?: string }

  const adminSecret = process.env.ADMIN_SECRET
  if (!adminSecret) return res.status(500).json({ ok: false, error: 'ADMIN_SECRET não configurado' })
  if (!secret || secret !== adminSecret) {
    await new Promise(r => setTimeout(r, 800)) // anti-bruteforce
    return res.status(401).json({ ok: false, error: 'Senha incorreta' })
  }

  const token = await new SignJWT({ admin: true, role: 'backoffice' })
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

  return res.status(200).json({ ok: true, token })
}
