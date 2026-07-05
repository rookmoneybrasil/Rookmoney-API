import { withBackofficeAuth, getBackofficeAdmin } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, badRequest } from '@/lib/respond'

export default withBackofficeAuth(async (req, res) => {
  const { userIds, subject, message } = req.body as {
    userIds?: string[]; subject?: string; message?: string
  }

  if (!Array.isArray(userIds) || userIds.length === 0) return badRequest(res, 'userIds é obrigatório.')
  if (!subject?.trim())  return badRequest(res, 'subject é obrigatório.')
  if (!message?.trim())  return badRequest(res, 'message é obrigatório.')
  if (userIds.length > 500) return badRequest(res, 'Máximo 500 usuários por envio.')

  const resendKey = process.env.RESEND_API_KEY
  if (!resendKey) return res.status(500).json({ ok: false, error: 'RESEND_API_KEY não configurado.' })

  const users = await db.user.findMany({
    where:  { id: { in: userIds } },
    select: { id: true, name: true, email: true },
  })

  const from = process.env.FROM_EMAIL ?? 'Rook Money <noreply@rookmoney.com>'
  let sent = 0; let failed = 0

  for (const user of users) {
    const controller = new AbortController()
    const timeout    = setTimeout(() => controller.abort(), 10_000)
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method:  'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from, to: [user.email], subject,
          html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
            <p>Olá, ${user.name}!</p>
            ${message.split('\n').map(p => `<p>${p}</p>`).join('')}
            <hr style="margin:24px 0;border:none;border-top:1px solid #eee">
            <p style="color:#999;font-size:12px">Equipe Rook Money</p>
          </div>`,
        }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout))
      if (r.ok) sent++; else failed++
    } catch {
      failed++
    }
  }

  await db.adminLog.create({
    data: {
      action:   'send_email',
      targetId: 'bulk',
      details:  `Email em massa: "${subject}" — ${sent}/${users.length} enviados`,
      actorEmail: getBackofficeAdmin(req).email,
    },
  })

  return ok(res, { sent, failed, total: users.length })
}, ['POST'])
