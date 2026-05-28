/**
 * Twilio WhatsApp client — raw fetch, no SDK.
 *
 * Env vars needed:
 *   TWILIO_ACCOUNT_SID   = ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *   TWILIO_AUTH_TOKEN    = xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *   TWILIO_WHATSAPP_FROM = whatsapp:+14155238886   (sandbox) or your approved number
 */

function twilioAuth(): string {
  const sid   = process.env.TWILIO_ACCOUNT_SID   ?? ''
  const token = process.env.TWILIO_AUTH_TOKEN     ?? ''
  return 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64')
}

export async function sendWhatsApp(to: string, body: string): Promise<void> {
  const sid  = process.env.TWILIO_ACCOUNT_SID   ?? ''
  const from = process.env.TWILIO_WHATSAPP_FROM ?? 'whatsapp:+14155238886'

  // to must be in whatsapp:+5511999999999 format
  const toWa = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method:  'POST',
      headers: {
        Authorization:  twilioAuth(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: from, To: toWa, Body: body }).toString(),
    },
  )

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Twilio error: ${err?.message ?? res.statusText}`)
  }
}

/**
 * Download a Twilio media URL (requires Basic auth with Twilio creds).
 * Returns the image as a base64 string + content-type.
 */
export async function downloadTwilioMedia(
  mediaUrl: string,
): Promise<{ base64: string; contentType: string }> {
  const res = await fetch(mediaUrl, {
    headers: { Authorization: twilioAuth() },
  })

  if (!res.ok) throw new Error(`Media download failed: ${res.status}`)

  const contentType = res.headers.get('content-type') ?? 'image/jpeg'
  const buffer      = await res.arrayBuffer()
  const base64      = Buffer.from(buffer).toString('base64')

  return { base64, contentType }
}

/**
 * Validate Twilio webhook signature.
 * Returns true if the request is genuinely from Twilio.
 */
export async function validateTwilioSignature(
  signature:    string,
  url:          string,
  params:       Record<string, string>,
): Promise<boolean> {
  const token = process.env.TWILIO_AUTH_TOKEN ?? ''
  if (!token) return true // dev: skip validation

  // Build the string to sign: URL + sorted params + values
  const sortedKeys = Object.keys(params).sort()
  const str = url + sortedKeys.map((k) => k + params[k]).join('')

  const key     = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(str))
  const expected  = Buffer.from(sigBuffer).toString('base64')

  return expected === signature
}
