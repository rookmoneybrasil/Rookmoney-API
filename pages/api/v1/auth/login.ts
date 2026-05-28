import type { NextApiRequest, NextApiResponse } from 'next'
import bcrypt from 'bcryptjs'
import { serialize } from 'cookie'
import { db } from '@/lib/db'
import { createToken } from '@/lib/auth'
import { withPublic, badRequest, unauthorized, serverError } from '@/lib/respond'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const { email, password, rememberMe = true } = req.body as {
    email:      string
    password:   string
    rememberMe: boolean
  }

  if (!email || !password) return badRequest(res, 'E-mail e senha são obrigatórios.')

  const user = await db.user.findUnique({ where: { email: email.toLowerCase().trim() } })
  if (!user)          return unauthorized(res, 'E-mail ou senha incorretos.')
  if (!user.password) return unauthorized(res, 'Esta conta usa login pelo Google.')

  const valid = await bcrypt.compare(password, user.password)
  if (!valid) return unauthorized(res, 'E-mail ou senha incorretos.')

  const token = await createToken({ userId: user.id, name: user.name, email: user.email }, rememberMe)

  // Set httpOnly cookie
  const maxAge = rememberMe ? 60 * 60 * 24 * 30 : undefined
  res.setHeader('Set-Cookie', serialize('rook_session', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path:     '/',
    ...(maxAge ? { maxAge } : {}),
  }))

  return res.status(200).json({ ok: true, data: { token, user: { id: user.id, name: user.name, email: user.email, plan: user.plan } } })
}
