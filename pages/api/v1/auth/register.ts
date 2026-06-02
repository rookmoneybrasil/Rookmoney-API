import type { NextApiRequest, NextApiResponse } from 'next'
import bcrypt from 'bcryptjs'
import { serialize } from 'cookie'
import { db } from '@/lib/db'
import { createToken } from '@/lib/auth'
import { badRequest } from '@/lib/respond'
import { rateLimit, getIp, tooManyRequests } from '@/lib/rate-limit'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  // Rate limit: 5 registros por IP a cada hora
  const rl = rateLimit(`register:${getIp(req)}`, 5, 60 * 60 * 1000)
  if (!rl.allowed) return tooManyRequests(res, rl.resetAt)

  const { name, email, password } = req.body as { name: string; email: string; password: string }

  if (!name || !email || !password) return badRequest(res, 'Nome, e-mail e senha são obrigatórios.')
  if (password.length < 8)               return badRequest(res, 'Senha deve ter no mínimo 8 caracteres.')
  if (!/[0-9]/.test(password))           return badRequest(res, 'Senha deve conter pelo menos um número.')
  if (!/[^a-zA-Z0-9]/.test(password))   return badRequest(res, 'Senha deve conter pelo menos um caractere especial.')

  const existing = await db.user.findUnique({ where: { email: email.toLowerCase().trim() } })
  if (existing) return badRequest(res, 'E-mail já cadastrado.')

  const hashed = await bcrypt.hash(password, 12)
  const user   = await db.user.create({
    data: { name: name.trim(), email: email.toLowerCase().trim(), password: hashed },
  })

  const token = await createToken({ userId: user.id, name: user.name, email: user.email })

  res.setHeader('Set-Cookie', serialize('rook_session', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    path:     '/',
    maxAge:   60 * 60 * 24 * 30,
  }))

  return res.status(201).json({ ok: true, data: { token, user: { id: user.id, name: user.name, email: user.email, plan: user.plan, hasOnboarded: user.hasOnboarded } } })
}
