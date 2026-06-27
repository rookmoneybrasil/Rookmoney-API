import type { NextApiRequest, NextApiResponse } from 'next'
import { db } from '@/lib/db'
import { ok, created, badRequest } from '@/lib/respond'
import { withBackofficeAuth } from '@/lib/middleware'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // GET is public — no auth required
  if (req.method === 'GET') {
    const { category, search, page = '1', pageSize = '20' } = req.query as Record<string, string>
    const skip = (parseInt(page) - 1) * parseInt(pageSize)
    const take = parseInt(pageSize)

    const where: Record<string, unknown> = { published: true }
    if (category) where.category = category
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { excerpt: { contains: search, mode: 'insensitive' } },
        { content: { contains: search, mode: 'insensitive' } },
      ]
    }

    const [items, total] = await Promise.all([
      db.blogPost.findMany({
        where, skip, take,
        orderBy: { createdAt: 'desc' },
        select: { id: true, slug: true, title: true, excerpt: true, category: true, image: true, imageAlt: true, author: true, createdAt: true },
      }),
      db.blogPost.count({ where }),
    ])

    return ok(res, { items, total, page: parseInt(page), totalPages: Math.ceil(total / take) })
  }

  // POST is admin-only
  return withBackofficeAuth(async (req, res) => {
    const { slug, title, excerpt, content, category, image, imageAlt, author, published } = req.body
    if (!slug || !title || !excerpt || !content || !category || !image) {
      return badRequest(res, 'Campos obrigatórios: slug, title, excerpt, content, category, image.')
    }

    const existing = await db.blogPost.findUnique({ where: { slug } })
    if (existing) return badRequest(res, 'Slug já existe.')

    const post = await db.blogPost.create({
      data: {
        slug, title, excerpt, content, category,
        image, imageAlt: imageAlt ?? title,
        author: author ?? 'Equipe Rook Money',
        published: published ?? true,
        source: 'manual',
      },
    })
    return created(res, post)
  })(req, res)
}
