import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, notFound } from '@/lib/respond'

export default withBackofficeAuth(async (req, res) => {
  if (req.method !== 'PATCH') return res.status(405).end()

  const id      = req.query.id as string
  const { status } = req.body as { status?: string }

  if (!status || !['open', 'reviewing', 'done'].includes(status)) {
    return res.status(400).json({ ok: false, error: 'Status inválido.' })
  }

  const existing = await db.feedback.findUnique({ where: { id } })
  if (!existing) return notFound(res)

  const updated = await db.feedback.update({ where: { id }, data: { status } })
  return ok(res, updated)
})
