import type { NextApiRequest, NextApiResponse } from 'next'
import { serialize } from 'cookie'

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Set-Cookie', serialize('rook_session', '', { path: '/', maxAge: 0 }))
  return res.status(200).json({ ok: true })
}
