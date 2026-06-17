import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, badRequest } from '@/lib/respond'
import { sendPush, isValidPushToken } from '@/lib/push'

export default withBackofficeAuth(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end()

  const { title, body, audience = 'all', screen } = req.body as {
    title: string; body: string; audience?: 'all' | 'pro'; screen?: string
  }

  if (!title?.trim() || !body?.trim()) return badRequest(res, 'title e body são obrigatórios')

  const where = audience === 'pro' ? { plan: 'PRO', pushToken: { not: null } } : { pushToken: { not: null } }

  const users = await db.user.findMany({
    where,
    select: { id: true, pushToken: true },
  })

  const messages = users
    .filter(u => isValidPushToken(u.pushToken))
    .map(u => ({
      to:    u.pushToken!,
      title: title.trim(),
      body:  body.trim(),
      sound: 'default' as const,
      ...(screen ? { data: { screen } } : {}),
    }))

  // Expo push accepts max 100 messages per request
  const CHUNK = 100
  let sent = 0
  for (let i = 0; i < messages.length; i += CHUNK) {
    await sendPush(messages.slice(i, i + CHUNK))
    sent += Math.min(CHUNK, messages.length - i)
  }

  await db.adminLog.create({ data: {
    action: 'push_broadcast', targetId: 'broadcast',
    details: `Push broadcast enviado para ${sent} dispositivos (${audience}) — "${title.trim()}"`,
  }})

  return ok(res, { sent, total: messages.length })
}, ['POST'])
