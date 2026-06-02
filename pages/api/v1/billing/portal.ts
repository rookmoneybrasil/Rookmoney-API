import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { createBillingPortal } from '@/lib/stripe'
import { ok, badRequest, serverError } from '@/lib/respond'

export default withAuth(async (req, res, session) => {
  if (req.method !== 'POST') return res.status(405).end()

  const user = await db.user.findUnique({
    where:  { id: session.userId },
    select: { stripeCustomerId: true },
  })

  if (!user?.stripeCustomerId) {
    return badRequest(res, 'Nenhuma assinatura encontrada.')
  }

  const returnUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://rookmoney.com'}/settings`

  try {
    const { url } = await createBillingPortal(user.stripeCustomerId, returnUrl)
    return ok(res, { url })
  } catch (err) {
    return serverError(res, err)
  }
})
