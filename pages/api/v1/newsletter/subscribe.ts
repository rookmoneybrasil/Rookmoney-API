import type { NextApiRequest, NextApiResponse } from 'next'
import { db } from '@/lib/db'
import { ok, badRequest, serverError } from '@/lib/respond'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método não permitido' })

  const { email, name } = req.body
  if (!email || typeof email !== 'string') return badRequest(res, 'Email obrigatório.')

  const normalized = email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return badRequest(res, 'Email inválido.')

  try {
    const existing = await db.newsletterSubscriber.findUnique({ where: { email: normalized } })

    if (existing) {
      if (existing.isActive) return ok(res, { message: 'Você já está inscrito!' })
      await db.newsletterSubscriber.update({ where: { id: existing.id }, data: { isActive: true } })
      return ok(res, { message: 'Inscrição reativada com sucesso!' })
    }

    await db.newsletterSubscriber.create({
      data: { email: normalized, name: name?.trim() || null },
    })

    return ok(res, { message: 'Inscrito com sucesso!' })
  } catch (err) {
    return serverError(res, err)
  }
}
