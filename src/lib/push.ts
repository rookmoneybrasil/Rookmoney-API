type PushMessage = {
  to: string
  title: string
  body: string
  data?: Record<string, unknown>
  sound?: 'default' | null
  badge?: number
}

export async function sendPush(messages: PushMessage[]) {
  if (!messages.length) return
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    })
  } catch (e) {
    console.error('[push] failed:', e)
  }
}

export function isValidPushToken(token: string | null | undefined): boolean {
  return !!token && token.startsWith('ExponentPushToken[')
}
