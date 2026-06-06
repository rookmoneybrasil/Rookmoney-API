import { withAuth } from '@/lib/middleware'
import { ok, serverError } from '@/lib/respond'
import { createConnectToken } from '@/lib/pluggy'

export default withAuth(async (_req, res, session) => {
  try {
    const accessToken = await createConnectToken(session.userId)
    return ok(res, { accessToken })
  } catch (err) {
    return serverError(res, err)
  }
}, ['POST'])
