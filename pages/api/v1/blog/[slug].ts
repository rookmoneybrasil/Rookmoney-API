import type { NextApiRequest, NextApiResponse } from 'next'
import { db } from '@/lib/db'
import { ok, noContent, notFound, badRequest } from '@/lib/respond'
import { withBackofficeAuth } from '@/lib/middleware'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const slug = req.query.slug as string

  // GET is public
  if (req.method === 'GET') {
    const post = await db.blogPost.findUnique({ where: { slug } })
    if (!post || !post.published) return notFound(res)
    return ok(res, post)
  }

  // PUT/PATCH/DELETE are admin-only
  return withBackofficeAuth(async (req, res) => {
    const post = await db.blogPost.findUnique({ where: { slug } })
    if (!post) return notFound(res)

    if (req.method === 'PUT' || req.method === 'PATCH') {
      const { title, excerpt, content, category, image, imageAlt, author, published } = req.body
      const updated = await db.blogPost.update({
        where: { slug },
        data: {
          ...(title     !== undefined && { title }),
          ...(excerpt   !== undefined && { excerpt }),
          ...(content   !== undefined && { content }),
          ...(category  !== undefined && { category }),
          ...(image     !== undefined && { image }),
          ...(imageAlt  !== undefined && { imageAlt }),
          ...(author    !== undefined && { author }),
          ...(published !== undefined && { published }),
        },
      })
      return ok(res, updated)
    }

    if (req.method === 'DELETE') {
      await db.blogPost.delete({ where: { slug } })
      return noContent(res)
    }

    return res.status(405).end()
  })(req, res)
}
