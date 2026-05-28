import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, noContent, notFound } from '@/lib/respond'

export default withAuth(async (req, res, session) => {
  const id = req.query.id as string
  const src = await db.incomeSource.findFirst({ where: { id, userId: session.userId } })
  if (!src) return notFound(res)

  if (req.method === 'GET') return ok(res, src)

  if (req.method === 'PUT' || req.method === 'PATCH') {
    const { name, type, amount, isRecurring, dayOfMonth, notes, categoryId } = req.body
    const updated = await db.incomeSource.update({
      where: { id },
      data: {
        ...(name        !== undefined && { name }),
        ...(type        !== undefined && { type }),
        ...(amount      !== undefined && { amount: parseFloat(amount) }),
        ...(isRecurring !== undefined && { isRecurring }),
        ...(dayOfMonth  !== undefined && { dayOfMonth: dayOfMonth ? parseInt(dayOfMonth) : null }),
        ...(notes       !== undefined && { notes }),
        ...(categoryId  !== undefined && { categoryId }),
      },
    })
    return ok(res, updated)
  }

  if (req.method === 'DELETE') {
    await db.incomeSource.deleteMany({ where: { id, userId: session.userId } })
    return noContent(res)
  }

  return res.status(405).end()
})
