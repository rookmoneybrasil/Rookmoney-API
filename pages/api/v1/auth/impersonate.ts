import type { NextApiRequest, NextApiResponse } from 'next'
import { jwtVerify, SignJWT } from 'jose'
import { serialize } from 'cookie'
import { db } from '@/lib/db'
import { badRequest, unauthorized } from '@/lib/respond'

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET ?? 'rook-dev-secret')

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const { token } = req.body as { token?: string }
  if (!token) return badRequest(res, 'token é obrigatório.')

  try {
    const { payload } = await jwtVerify(token, SECRET)
    if (payload.purpose !== 'impersonate') return unauthorized(res, 'Token inválido.')

    const userId = payload.userId as string
    const user   = await db.user.findUnique({
      where:  { id: userId },
      select: { id: true, name: true, email: true, plan: true, tokenVersion: true },
    })
    if (!user) return unauthorized(res, 'Usuário não encontrado.')

    const sessionToken = await new SignJWT({
      userId:        user.id,
      name:          user.name,
      email:         user.email,
      plan:          user.plan,
      tokenVersion:  user.tokenVersion,
      impersonating: true,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('30m')
      .setIssuedAt()
      .sign(SECRET)

    res.setHeader('Set-Cookie', serialize('rook_session', sessionToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      path:     '/',
      maxAge:   60 * 30,
    }))

    return res.status(200).json({
      ok:   true,
      data: { user: { id: user.id, name: user.name, email: user.email, plan: user.plan } },
    })
  } catch {
    return unauthorized(res, 'Token expirado ou inválido.')
  }
}
