function getSecretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('Stripe not configured')
  return key
}

function stripeAuth() {
  return 'Basic ' + Buffer.from(getSecretKey() + ':').toString('base64')
}

async function stripeGet(path: string, params?: Record<string, string>): Promise<Record<string, unknown>> {
  const qs = params ? '?' + new URLSearchParams(params).toString() : ''
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  const res = await fetch(`https://api.stripe.com${path}${qs}`, {
    headers: { Authorization: stripeAuth() },
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout))
  const data = await res.json()
  if (!res.ok) throw new Error(data?.error?.message ?? 'Stripe error')
  return data as Record<string, unknown>
}

export interface StripeSub {
  id: string
  customer: string
  status: string
  current_period_end: number
  cancel_at_period_end: boolean
  cancel_at: number | null
  items: { data: { current_period_end?: number; price: { unit_amount: number; currency: string } }[] }
}

export async function listActiveSubscriptions(): Promise<StripeSub[]> {
  const all: StripeSub[] = []
  let startingAfter: string | undefined
  for (;;) {
    const params: Record<string, string> = { limit: '100', status: 'active', expand: 'data.items' }
    if (startingAfter) params['starting_after'] = startingAfter
    const data = await stripeGet('/v1/subscriptions', params)
    const rows = data['data'] as StripeSub[]
    all.push(...rows)
    if (!data['has_more']) break
    startingAfter = rows[rows.length - 1].id
  }
  return all
}

async function stripePost(path: string, body: Record<string, string>) {
  const params     = new URLSearchParams(body)
  const controller = new AbortController()
  const timeout    = setTimeout(() => controller.abort(), 15_000) // 15s timeout
  const res = await fetch(`https://api.stripe.com${path}`, {
    method:  'POST',
    headers: {
      Authorization:  stripeAuth(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body:   params.toString(),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout))

  const data = await res.json()
  if (!res.ok) {
    throw new Error(data?.error?.message ?? 'Stripe error')
  }
  return data
}

export async function getSubscription(subscriptionId: string): Promise<StripeSub | null> {
  try {
    const data = await stripeGet(`/v1/subscriptions/${subscriptionId}`)
    return data as unknown as StripeSub
  } catch (err) {
    console.error('[stripe] getSubscription failed:', subscriptionId, err instanceof Error ? err.message : err)
    return null
  }
}

export function getPriceId(plan: 'PRO' | 'PRO_PLUS', annual = false): string {
  if (plan === 'PRO_PLUS') {
    const id = annual
      ? (process.env.STRIPE_PRO_PLUS_ANNUAL_PRICE_ID ?? process.env.STRIPE_PRO_PLUS_PRICE_ID)
      : process.env.STRIPE_PRO_PLUS_PRICE_ID
    if (!id) throw new Error('STRIPE_PRO_PLUS_PRICE_ID not configured')
    return id
  }
  const id = annual
    ? (process.env.STRIPE_ANNUAL_PRICE_ID ?? process.env.STRIPE_PRICE_ID)
    : process.env.STRIPE_PRICE_ID
  if (!id) throw new Error('STRIPE_PRICE_ID not configured')
  return id
}

export function planFromPriceId(priceId: string): 'PRO' | 'PRO_PLUS' {
  const proPlus = process.env.STRIPE_PRO_PLUS_PRICE_ID
  const proPlusAnnual = process.env.STRIPE_PRO_PLUS_ANNUAL_PRICE_ID
  if (priceId === proPlus || priceId === proPlusAnnual) return 'PRO_PLUS'
  return 'PRO'
}

export async function cancelSubscription(subscriptionId: string): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
    method: 'DELETE',
    headers: { Authorization: stripeAuth() },
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout))
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data?.error?.message ?? 'Stripe cancel error')
  }
}

export async function createCheckoutSession(
  userId: string,
  email: string,
  returnUrl: string,
  plan: 'PRO' | 'PRO_PLUS' = 'PRO',
  annual = false,
): Promise<{ url: string }> {
  const priceId = getPriceId(plan, annual)

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
