import type { NextApiRequest, NextApiResponse } from 'next'
import { serialize } from 'cookie'

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3010,http://localhost:3020').split(',').map(o => o.trim())
  const origin  = req.headers.origin as string | undefined
  const allow   = (origin && allowed.includes(origin)) ? origin : allowed[0]
  res.setHeader('Access-Control-Allow-Origin',      allow)
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Set-Cookie', serialize('rook_backoffice', '', { path: '/', maxAge: 0 }))
  return res.status(200).json({ ok: true })
}
