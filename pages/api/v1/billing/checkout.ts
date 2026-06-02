import { withAuth } from '@/lib/middleware'
import { createCheckoutSession } from '@/lib/stripe'
import { ok, serverError } from '@/lib/respond'

export default withAuth(async (req, res, session) => {
  if (req.method !== 'POST') return res.status(405).end()

  // Always use NEXT_PUBLIC_APP_URL — never trust req.headers.origin
  // (proxy headers can leak localhost in dev when both local and prod are open)
  const returnUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://rookmoney.com'}/settings`

  const annual = req.body?.annual === true

  try {
    const { url } = await createCheckoutSession(session.userId, session.email, returnUrl, annual)
    return ok(res, { url })
  } catch (err) {
    return serverError(res, err)
  }
})
