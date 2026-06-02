import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, badRequest, notFound } from '@/lib/respond'

export default withBackofficeAuth(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end()

  const { userId, subject, message } = req.body as { userId?: string; subject?: string; message?: string }

  if (!userId || !subject?.trim() || !message?.trim()) {
    return badRequest(res, 'userId, subject e message são obrigatórios.')
  }
  if (subject.length > 200) return badRequest(res, 'Assunto muito longo.')
  if (message.length > 5000) return badRequest(res, 'Mensagem muito longa.')

  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true } })
  if (!user) return notFound(res)

  const resendKey = process.env.RESEND_API_KEY
  if (!resendKey) return res.status(500).json({ ok: false, error: 'RESEND_API_KEY não configurado.' })

  const from = process.env.FROM_EMAIL ?? 'Rook Money <noreply@rookmoney.com>'

  const controller = new AbortController()
  const timeout    = setTimeout(() => controller.abort(), 10_000)
  const resendRes  = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      from, to: [user.email],
      subject,
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <p>Olá, ${user.name}!</p>
        ${message.split('\n').map(p => `<p>${p}</p>`).join('')}
        <hr style="margin:24px 0;border:none;border-top:1px solid #eee">
        <p style="color:#999;font-size:12px">Equipe Rook Money</p>
      </div>`,
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout))

  if (!resendRes.ok) {
    const err = await resendRes.json().catch(() => ({})) as { message?: string }
    return res.status(500).json({ ok: false, error: err.message ?? 'Falha ao enviar email.' })
  }

  // Log the action
  await db.adminLog.create({
    data: { action: 'send_email', targetId: userId, details: `Email enviado para ${user.email}: "${subject}"` }
  })

  return ok(res, { message: 'Email enviado com sucesso.' })
})
