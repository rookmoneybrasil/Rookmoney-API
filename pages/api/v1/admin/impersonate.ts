import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, badRequest, notFound } from '@/lib/respond'
import { SignJWT } from 'jose'

const SECRET  = new TextEncoder().encode(process.env.JWT_SECRET ?? 'rook-dev-secret')
const WEB_URL = process.env.WEB_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://rookmoney.com'

export default withBackofficeAuth(async (req, res) => {
  const { userId } = req.body as { userId?: string }
  if (!userId) return badRequest(res, 'userId é obrigatório.')

  const user = await db.user.findUnique({
    where:  { id: userId },
    select: { id: true, name: true, email: true },
  })
  if (!user) return notFound(res)

  const token = await new SignJWT({ userId: user.id, purpose: 'impersonate' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('5m')
    .setIssuedAt()
    .sign(SECRET)

  return ok(res, { url: `${WEB_URL}/auth/impersonate?token=${token}`, user })
}, ['POST'], { requireRole: 'superadmin' })
