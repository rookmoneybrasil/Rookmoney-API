const PACKAGE_NAME = 'com.rookmoney.app'

interface GooglePlaySubscription {
  kind: string
  startTimeMillis: string
  expiryTimeMillis: string
  autoRenewing: boolean
  priceCurrencyCode: string
  priceAmountMicros: string
  paymentState?: number
  cancelReason?: number
  orderId: string
  acknowledgementState: number
}

export type GooglePlan = 'PRO' | 'PRO_PLUS'

const PRODUCT_TO_PLAN: Record<string, GooglePlan> = {
  rook_pro_monthly:      'PRO',
  rook_pro_annual:       'PRO',
  rook_pro_plus_monthly: 'PRO_PLUS',
  rook_pro_plus_annual:  'PRO_PLUS',
}

export function planFromProductId(productId: string): GooglePlan {
  return PRODUCT_TO_PLAN[productId] ?? 'PRO'
}

async function getAccessToken(): Promise<string> {
  const credentials = process.env.GOOGLE_PLAY_CREDENTIALS
  if (!credentials) throw new Error('GOOGLE_PLAY_CREDENTIALS not configured')

  const parsed = JSON.parse(credentials)
  const now = Math.floor(Date.now() / 1000)

  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = btoa(JSON.stringify({
    iss: parsed.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }))

  const { createSign } = await import('crypto')
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  const signature = signer.sign(parsed.private_key, 'base64url')

  const jwt = `${header}.${payload}.${signature}`

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Google OAuth failed: ${text}`)
  }

  const data = await res.json()
  return data.access_token
}

export async function verifySubscription(
  productId: string,
  purchaseToken: string,
): Promise<GooglePlaySubscription> {
  const accessToken = await getAccessToken()

  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}/purchases/subscriptions/${productId}/tokens/${purchaseToken}`

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Google Play verification failed: ${text}`)
  }

  return res.json()
}

export async function acknowledgeSubscription(
  productId: string,
  purchaseToken: string,
): Promise<void> {
  const accessToken = await getAccessToken()

  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}/purchases/subscriptions/${productId}/tokens/${purchaseToken}:acknowledge`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Google Play acknowledge failed: ${text}`)
  }
}

export function isSubscriptionActive(sub: GooglePlaySubscription): boolean {
  const now = Date.now()
  const expiry = parseInt(sub.expiryTimeMillis, 10)
  return expiry > now && (sub.paymentState === 1 || sub.paymentState === 2)
}
