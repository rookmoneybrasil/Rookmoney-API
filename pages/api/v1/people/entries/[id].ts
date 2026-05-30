import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, noContent, notFound } from '@/lib/respond'

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
      // Create a transaction to reflect the cash movement
      const txType = entry.type === 'I_OWE_THEM' ? 'EXPENSE' : 'INCOME'

      const categoryId = entry.categoryId ?? (
        await db.category.findFirst({
          where:   { OR: [{ isDefault: true }, { userId: session.userId }] },
          orderBy: { isDefault: 'desc' },
        })
      )?.id ?? null

      const personName = (entry as typeof entry & { person: { name: string } }).person?.name
      const txDescription = personName
        ? `${entry.description} (${personName})`
        : entry.description

      const tx = await db.transaction.create({
        data: {
          amount:      entry.amount,
          type:        txType,
          description: txDescription,
          date:        new Date(),
          userId:      session.userId,
          categoryId:  categoryId!,
        },
      })

      const updated = await db.personEntry.update({
        where: { id },
        data:  { isSettled: true, settledAt: new Date(), settledTransactionId: tx.id },
      })
      return ok(res, updated)
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
      const groupData: Record<string, unknown> = {}
      if (type        !== undefined) groupData.type        = type
      if (description !== undefined) groupData.description = description
      if (categoryId  !== undefined) groupData.categoryId  = categoryId || null
      if (amount      !== undefined) groupData.amount      = parseFloat(amount)
      // For groups: don't apply date globally — each installment keeps its own date
      await db.personEntry.updateMany({
        where: { installmentGroupId: entry.installmentGroupId, userId: session.userId },
        data:  groupData,
      })
      const updated = await db.personEntry.findFirst({ where: { id, userId: session.userId } })
      return ok(res, updated)
    }

    const updated = await db.personEntry.update({ where: { id }, data })
    return ok(res, updated)
  }

  if (req.method === 'DELETE') {
    // applyToGroup=true → delete all installments in the group
    if (req.query.applyToGroup === 'true' && entry.installmentGroupId) {
      await db.personEntry.deleteMany({
        where: { installmentGroupId: entry.installmentGroupId, userId: session.userId },
      })
    } else {
      await db.personEntry.deleteMany({ where: { id, userId: session.userId } })
    }
    return noContent(res)
  }

  return res.status(405).end()
})
