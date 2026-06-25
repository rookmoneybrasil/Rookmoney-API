import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, badRequest } from '@/lib/respond'
import { isValidPushToken } from '@/lib/push'

export default withAuth(async (req, res, session) => {
  const uid = session.userId

  if (req.method === 'POST') {
    const { token, platform } = req.body as { token?: string; platform?: string }
    if (!token || !isValidPushToken(token)) return badRequest(res, 'Token inválido.')
    const data: Record<string, unknown> = { pushToken: token }
    if (platform === 'android' || platform === 'ios') data.platform = platform
    await db.user.update({ where: { id: uid }, data })
    return ok(res, {})
  }

  if (req.method === 'DELETE') {
    await db.user.update({ where: { id: uid }, data: { pushToken: null } })
    return ok(res, {})
  }

  return res.status(405).end()
})
