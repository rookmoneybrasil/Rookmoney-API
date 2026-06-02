import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, noContent, notFound } from '@/lib/respond'

export default withAuth(async (req, res, session) => {
  const id  = req.query.id as string
  const uid = session.userId

  const item = await db.personEntryRecurring.findFirst({ where: { id, userId: uid } })
  if (!item) return notFound(res)

  // PATCH — update any fields or pause/resume
  if (req.method === 'PATCH') {
    const { isActive, description, amount, dayOfMonth, categoryId, notes } = req.body
    const updated = await db.personEntryRecurring.update({
      where: { id },
      data: {
        ...(isActive    !== undefined && { isActive:    Boolean(isActive) }),
        ...(description !== undefined && { description }),
        ...(amount      !== undefined && { amount:      parseFloat(amount) }),
        ...(dayOfMonth  !== undefined && { dayOfMonth:  Math.min(Math.max(parseInt(dayOfMonth), 1), 28) }),
        ...(categoryId  !== undefined && { categoryId:  categoryId || null }),
        ...(notes       !== undefined && { notes:       notes || null }),
      },
      include: {
        person:   { select: { id: true, name: true, color: true } },
        category: { select: { id: true, name: true, icon: true, color: true } },
      },
    })
    return ok(res, updated)
  }

  // DELETE — stop permanently
  if (req.method === 'DELETE') {
    await db.personEntryRecurring.delete({ where: { id } })
    return noContent(res)
  }

  return res.status(405).end()
})
