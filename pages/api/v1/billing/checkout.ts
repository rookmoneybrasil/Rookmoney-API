import { withAuth } from '@/lib/middleware'
import { createCheckoutSession } from '@/lib/stripe'
import { ok, serverError } from '@/lib/respond'

export default withAuth(async (req, res, session) => {
  if (req.method !== 'POST') return res.status(405).end()

  const origin    = (req.headers.origin as string) ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3001'
  const returnUrl = `${origin}/settings`

  try {
    const { url } = await createCheckoutSession(session.userId, session.email, returnUrl)
    return ok(res, { url })
  } catch (err) {
    return serverError(res, err)
  }
})
