import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, badRequest } from '@/lib/respond'
import { isValidPushToken } from '@/lib/push'

export default withAuth(async (req, res, session) => {
  const uid = session.userId

  if (req.method === 'POST') {
    const { token } = req.body as { token?: string }
    if (!token || !isValidPushToken(token)) return badRequest(res, 'Token inválido.')
    await db.user.update({ where: { id: uid }, data: { pushToken: token } })
    return ok(res, {})
  }

  if (req.method === 'DELETE') {
    await db.user.update({ where: { id: uid }, data: { pushToken: null } })
    return ok(res, {})
  }

  return res.status(405).end()
})
