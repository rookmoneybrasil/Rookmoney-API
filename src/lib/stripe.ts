function getSecretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('Stripe not configured')
  return key
}

function stripeAuth() {
  return 'Basic ' + Buffer.from(getSecretKey() + ':').toString('base64')
}

async function stripePost(path: string, body: Record<string, string>) {
  const params = new URLSearchParams(body)
  const res = await fetch(`https://api.stripe.com${path}`, {
    method:  'POST',
    headers: {
      Authorization:  stripeAuth(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  })

  const data = await res.json()
  if (!res.ok) {
    throw new Error(data?.error?.message ?? 'Stripe error')
  }
  return data
}

export async function createCheckoutSession(
  userId: string,
  email: string,
  returnUrl: string,
  annual = false,
): Promise<{ url: string }> {
  const priceId = annual
    ? (process.env.STRIPE_ANNUAL_PRICE_ID ?? process.env.STRIPE_PRICE_ID)
    : process.env.STRIPE_PRICE_ID
  if (!priceId) throw new Error('STRIPE_PRICE_ID not configured')

  const data = await stripePost('/v1/checkout/sessions', {
    'payment_method_types[0]':         'card',
    'line_items[0][price]':            priceId,
    'line_items[0][quantity]':         '1',
    mode:                              'subscription',
    success_url:                       `${returnUrl}?upgraded=1`,
    cancel_url:                        returnUrl,
    customer_email:                    email,
    'metadata[userId]':                userId,
    'subscription_data[metadata][userId]': userId,
  })

  return { url: data.url }
}

export async function createBillingPortal(
  customerId: string,
  returnUrl: string,
): Promise<{ url: string }> {
  const data = await stripePost('/v1/billing_portal/sessions', {
    customer:   customerId,
    return_url: returnUrl,
  })

  return { url: data.url }
}
