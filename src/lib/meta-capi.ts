import crypto from 'crypto'
import type { NextApiRequest } from 'next'

const PIXEL_ID     = process.env.META_PIXEL_ID
const ACCESS_TOKEN = process.env.META_CAPI_TOKEN
const API_VERSION  = 'v20.0'

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex')
}

interface UserData {
  email?: string
  ip?: string
  userAgent?: string
  fbc?: string
  fbp?: string
}

interface EventParams {
  eventName: string
  eventId: string
  sourceUrl: string
  userData: UserData
  value?: number
  currency?: string
}

export function extractMetaUserData(req: NextApiRequest, email?: string): UserData {
  const forwarded = req.headers['x-forwarded-for']
  const ip = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.socket?.remoteAddress

  const cookies = req.headers.cookie ?? ''
  const fbc = cookies.match(/(?:^|;\s*)_fbc=([^;]*)/)?.[1]
  const fbp = cookies.match(/(?:^|;\s*)_fbp=([^;]*)/)?.[1]

  return {
    email,
    ip: ip ?? undefined,
    userAgent: req.headers['user-agent'] ?? undefined,
    fbc: fbc ?? undefined,
    fbp: fbp ?? undefined,
  }
}

export async function sendMetaEvent(params: EventParams): Promise<void> {
  if (!PIXEL_ID || !ACCESS_TOKEN) return

  const { eventName, eventId, sourceUrl, userData, value, currency } = params

  const userDataPayload: Record<string, unknown> = {
    client_ip_address: userData.ip,
    client_user_agent: userData.userAgent,
  }

  if (userData.email) userDataPayload.em = [sha256(userData.email)]
  if (userData.fbc)   userDataPayload.fbc = userData.fbc
  if (userData.fbp)   userDataPayload.fbp = userData.fbp

  const eventData: Record<string, unknown> = {
    event_name:   eventName,
    event_time:   Math.floor(Date.now() / 1000),
    event_id:     eventId,
    action_source: 'website',
    event_source_url: sourceUrl,
    user_data:    userDataPayload,
  }

  if (value != null && currency) {
    eventData.custom_data = { value, currency }
  }

  const url = `https://graph.facebook.com/${API_VERSION}/${PIXEL_ID}/events`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data:         [eventData],
        access_token: ACCESS_TOKEN,
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error('[meta-capi] error:', res.status, body)
    }
  } catch (err) {
    console.error('[meta-capi] fetch failed:', err)
  }
}
