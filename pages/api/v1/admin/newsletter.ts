import type { NextApiRequest, NextApiResponse } from 'next'
import { db } from '@/lib/db'
import { ok, badRequest, notFound, serverError } from '@/lib/respond'
import { withBackofficeAuth } from '@/lib/middleware'

export default withBackofficeAuth(async (req, res) => {
  if (req.method === 'GET') {
    const { search, status, page = '1', pageSize = '50' } = req.query as Record<string, string>
    const skip = (parseInt(page) - 1) * parseInt(pageSize)
    const take = parseInt(pageSize)

    const where: Record<string, unknown> = {}
    if (status === 'active') where.isActive = true
    if (status === 'inactive') where.isActive = false
    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
      ]
    }

    const [items, total, activeCount] = await Promise.all([
      db.newsletterSubscriber.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      db.newsletterSubscriber.count({ where }),
      db.newsletterSubscriber.count({ where: { isActive: true } }),
    ])

    return ok(res, {
      items,
      total,
      activeCount,
      page: parseInt(page),
      totalPages: Math.ceil(total / take),
    })
  }

  if (req.method === 'DELETE') {
    const { id } = req.body
    if (!id) return badRequest(res, 'ID obrigatório.')

    const sub = await db.newsletterSubscriber.findUnique({ where: { id } })
    if (!sub) return notFound(res, 'Inscrição não encontrada.')

    await db.newsletterSubscriber.delete({ where: { id } })
    return ok(res, { deleted: true })
  }

  if (req.method === 'PATCH') {
    const { id, isActive } = req.body
    if (!id || typeof isActive !== 'boolean') return badRequest(res, 'ID e isActive obrigatórios.')

    const sub = await db.newsletterSubscriber.findUnique({ where: { id } })
    if (!sub) return notFound(res, 'Inscrição não encontrada.')

    const updated = await db.newsletterSubscriber.update({ where: { id }, data: { isActive } })
    return ok(res, updated)
  }

  return res.status(405).json({ ok: false, error: 'Método não permitido' })
})
