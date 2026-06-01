import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, created, badRequest } from '@/lib/respond'

export default withAuth(async (req, res, session) => {
  if (req.method !== 'POST') return res.status(405).end()

  const { type, title, body } = req.body as { type?: string; title?: string; body?: string }

  if (!type || !['bug', 'suggestion', 'ticket'].includes(type)) return badRequest(res, 'Tipo inválido.')
  if (!title?.trim()) return badRequest(res, 'Título obrigatório.')
  if (!body?.trim())  return badRequest(res, 'Descrição obrigatória.')
  if (title.length > 120) return badRequest(res, 'Título muito longo.')
  if (body.length > 2000)  return badRequest(res, 'Descrição muito longa.')

  const feedback = await db.feedback.create({
    data: { type, title: title.trim(), body: body.trim(), userId: session.userId },
  })

  return created(res, { id: feedback.id })
})
