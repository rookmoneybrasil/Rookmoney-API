import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, noContent, notFound } from '@/lib/respond'
import { payRecurringPersonEntry } from '@/lib/process-recurring-people'

export default withAuth(async (req, res, session) => {
  const id  = req.query.id as string
  const uid = session.userId

  const item = await db.personEntryRecurring.findFirst({ where: { id, userId: uid } })
  if (!item) return notFound(res)

  // POST?action=pay — ensure this month's entry exists (creating it if the
  // day-of-month gate hasn't been hit yet) and settle it. Replaces the old
  // "create ad-hoc entry + settle" flow the web/mobile "Pago" buttons used,
  // which could race with the cron and create a duplicate entry.
  if (req.method === 'POST' && req.query.action === 'pay') {
    try {
      const entry = await payRecurringPersonEntry(uid, id)
      if (!entry) return notFound(res)
      return ok(res, entry)
    } catch (err) {
      return res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Não foi possível pagar.' })
    }
  }

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
    return ok(res, updated)
  }

  // DELETE — stop permanently
  if (req.method === 'DELETE') {
    await db.personEntryRecurring.delete({ where: { id } })
    return noContent(res)
  }

  return res.status(405).end()
})
