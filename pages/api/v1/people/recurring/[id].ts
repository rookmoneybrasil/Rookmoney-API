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
        ...(dayOfMonth  !== undefined && { dayOfMonth:  Math.min(Math.max(parseInt(dayOfMonth, 10) || 1, 1), 31) }),
        ...(categoryId  !== undefined && { categoryId:  categoryId || null }),
        ...(notes       !== undefined && { notes:       notes || null }),
      },
      include: {
        person:   { select: { id: true, name: true, color: true } },
        category: { select: { id: true, name: true, icon: true, color: true } },
      },
    })

    // Pausing removes THIS month's obligation (rule: "desativar para o mês atual
    // e futuros"). Delete only the current-month UNSETTLED generated entry so it
    // stops counting everywhere — settled ones stay as history, past-month
    // overdue entries stay (independent "atrasos"). Reactivating regenerates it.
    if (isActive === false) {
      const now        = new Date()
      const monthStart = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1))
      const monthEnd   = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59))
      await db.personEntry.deleteMany({
        where: { recurringEntryId: id, userId: uid, isSettled: false, date: { gte: monthStart, lte: monthEnd } },
      })
    }
    return ok(res, updated)
  }

  // DELETE — stop permanently
  if (req.method === 'DELETE') {
    await db.personEntryRecurring.delete({ where: { id } })
    return noContent(res)
  }

  return res.status(405).end()
})
