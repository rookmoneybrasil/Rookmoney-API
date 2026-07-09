import { withAuth } from '@/lib/middleware'
import { createCheckoutSession } from '@/lib/stripe'
import { ok, serverError } from '@/lib/respond'

export default withAuth(async (req, res, session) => {
  if (req.method !== 'POST') return res.status(405).end()

  const appUrl    = process.env.NEXT_PUBLIC_APP_URL ?? 'https://rookmoney.com'
  const returnUrl = `${appUrl}/billing`

  const plan = req.body?.plan === 'PRO_PLUS' ? 'PRO_PLUS' as const : 'PRO' as const
  const annual = req.body?.annual === true

  // Sucesso → dashboard (WelcomeProModal dispara no ?upgraded=1). Cancelar → volta pra /billing.
  const successUrl = `${appUrl}/dashboard?upgraded=1&plan=${plan}`

  try {
    const { url } = await createCheckoutSession(session.userId, session.email, returnUrl, plan, annual, successUrl)
    return ok(res, { url })
  } catch (err) {
    return serverError(res, err)
  }
})
