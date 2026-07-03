import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, noContent, notFound } from '@/lib/respond'
import { settlePersonEntry } from '@/lib/process-recurring-people'

export default withAuth(async (req, res, session) => {
  const id    = req.query.id as string
  const entry = await db.personEntry.findFirst({
    where:   { id, userId: session.userId },
    include: { person: { select: { name: true } } },
  })
  if (!entry) return notFound(res)

  // POST?action=settle or POST?action=unsettle
  if (req.method === 'POST') {
    const action   = req.query.action as string
    const isSettle = action === 'settle'

    if (isSettle && !entry.isSettled) {
      try {
        const updated = await settlePersonEntry(session.userId, id)
        return ok(res, updated)
      } catch (err) {
        return res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Não foi possível acertar.' })
      }
    }

    if (!isSettle && entry.isSettled) {
      // Undo settlement — remove the transaction if it exists
      if (entry.settledTransactionId) {
        await db.transaction.deleteMany({ where: { id: entry.settledTransactionId, userId: session.userId } })
      }
      const updated = await db.personEntry.update({
        where: { id },
        data:  { isSettled: false, settledAt: null, settledTransactionId: null },
      })
      return ok(res, updated)
    }

    return ok(res, entry)
  }

  if (req.method === 'PATCH' || req.method === 'PUT') {
    const { type, description, amount, date, categoryId, notes, applyToGroup } = req.body

    const data: Record<string, unknown> = {}
    if (type        !== undefined) data.type        = type
    if (description !== undefined) data.description = description
    if (amount      !== undefined) data.amount      = parseFloat(amount)
    if (date !== undefined && date) {
      // UTC noon to avoid timezone day-shift for Brazil users
      const [y, m, d] = (date as string).split('-').map(Number)
      data.date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
    }
    if (categoryId  !== undefined) data.categoryId  = categoryId || null
    if (notes       !== undefined) data.notes       = notes || null

    if (applyToGroup && entry.installmentGroupId) {
      // Update description/type/category/amount for ALL pending installments
      const groupData: Record<string, unknown> = {}
      if (type        !== undefined) groupData.type        = type
      if (description !== undefined) groupData.description = description
      if (categoryId  !== undefined) groupData.categoryId  = categoryId || null
      if (amount      !== undefined) groupData.amount      = parseFloat(amount)
      await db.personEntry.updateMany({
        where: { installmentGroupId: entry.installmentGroupId, userId: session.userId, isSettled: false },
        data:  groupData,
      })

      // Update date only for the NEXT upcoming (closest) installment
      if (data.date) {
        const next = await db.personEntry.findFirst({
          where:   { installmentGroupId: entry.installmentGroupId, userId: session.userId, isSettled: false },
          orderBy: { date: 'asc' },
        })
        if (next) {
          await db.personEntry.update({ where: { id: next.id }, data: { date: data.date as Date } })
        }
      }
      const updated = await db.personEntry.findFirst({ where: { id, userId: session.userId } })
      return ok(res, updated)
    }

    const updated = await db.personEntry.update({ where: { id }, data })
    return ok(res, updated)
  }

  if (req.method === 'DELETE') {
    // applyToGroup=true → delete all installments in the group
    if (req.query.applyToGroup === 'true' && entry.installmentGroupId) {
      // Collect settled transaction IDs from all group entries before deleting
      const groupEntries = await db.personEntry.findMany({
        where:  { installmentGroupId: entry.installmentGroupId, userId: session.userId },
        select: { settledTransactionId: true },
      })
      const txIds = groupEntries.map(e => e.settledTransactionId).filter(Boolean) as string[]
      await db.personEntry.deleteMany({
        where: { installmentGroupId: entry.installmentGroupId, userId: session.userId },
      })
      if (txIds.length > 0) {
        await db.transaction.deleteMany({ where: { id: { in: txIds }, userId: session.userId } })
      }
    } else {
      await db.personEntry.deleteMany({ where: { id, userId: session.userId } })
      if (entry.settledTransactionId) {
        await db.transaction.deleteMany({ where: { id: entry.settledTransactionId, userId: session.userId } })
      }
      // No need to touch the recurring template here: processRecurringPersonEntries
      // no longer skips by lastMonth — it checks the real entry every load and
      // regenerates this month's Pendente card if the deleted one left none.
    }
    return noContent(res)
  }

  return res.status(405).end()
})
