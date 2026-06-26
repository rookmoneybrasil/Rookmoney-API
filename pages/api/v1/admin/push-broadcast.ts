import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, badRequest } from '@/lib/respond'
import { sendPush, isValidPushToken } from '@/lib/push'

export default withBackofficeAuth(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end()

  const { title, body, audience = 'all', screen } = req.body as {
    title: string; body: string; audience?: 'all' | 'pro' | 'pro_plus'; screen?: string
  }

  if (!title?.trim() || !body?.trim()) return badRequest(res, 'title e body são obrigatórios')

  const pushWhere = audience === 'pro'
    ? { plan: { in: ['PRO', 'PRO_PLUS'] }, pushToken: { not: null } }
    : audience === 'pro_plus'
    ? { plan: 'PRO_PLUS' as const, pushToken: { not: null } }
    : { pushToken: { not: null } }

  const allWhere = audience === 'pro'
    ? { plan: { in: ['PRO', 'PRO_PLUS'] } }
    : audience === 'pro_plus'
    ? { plan: 'PRO_PLUS' as const }
    : {}

  const [pushUsers, allUsers] = await Promise.all([
    db.user.findMany({ where: pushWhere, select: { id: true, pushToken: true } }),
    db.user.findMany({ where: allWhere, select: { id: true } }),
  ])

  const users = pushUsers

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

  // Save to PushLog for ALL users in audience (not just push-enabled)
  await db.pushLog.createMany({
    data: allUsers.map(u => ({
      userId: u.id,
      title:  title.trim(),
      body:   body.trim(),
      screen: screen ?? null,
    })),
  }).catch(e => console.error('[pushlog] broadcast save failed:', e))

  await db.adminLog.create({ data: {
    action: 'push_broadcast', targetId: 'broadcast',
    details: `Push broadcast enviado para ${sent} dispositivos (${audience}) — "${title.trim()}"`,
  }})

  return ok(res, { sent, total: messages.length })
}, ['POST'])
