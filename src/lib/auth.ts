import { SignJWT, jwtVerify } from 'jose'
import type { NextApiRequest } from 'next'

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET ?? 'rook-dev-secret')

export interface Session {
  userId: string
  name:   string
  email:  string
}

export async function createToken(session: Session, rememberMe = true): Promise<string> {
  return new SignJWT({ ...session })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(rememberMe ? '30d' : '1d')
    .setIssuedAt()
    .sign(SECRET)
}

export async function verifyToken(token: string): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET)
    return payload as unknown as Session
  } catch {
    return null
  }
}

export async function getSessionFromRequest(req: NextApiRequest): Promise<Session | null> {
  // 1. Cookie (web clients)
  const cookie = req.cookies['rook_session']
  if (cookie) return verifyToken(cookie)

  // 2. Authorization: Bearer <token> (mobile / API clients)
  const auth = req.headers.authorization
  if (auth?.startsWith('Bearer ')) return verifyToken(auth.slice(7))

  return null
}
