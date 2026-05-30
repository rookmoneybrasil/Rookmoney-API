import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'
import { format } from 'date-fns'

// One-time migration: convert old 120-installment groups → PersonEntryRecurring
// Safe to call multiple times (idempotent)
export default withAuth(async (req, res, session) => {
  if (req.method !== 'POST') return res.status(405).end()

  const uid = session.userId
  const now = new Date()

  // Find all installment groups with >= 24 installments (likely recurring, not real installments)
  const entries = await db.personEntry.findMany({
    where:   { userId: uid, isSettled: false, installmentGroupId: { not: null }, installmentTotal: { gte: 24 } },
    orderBy: { installmentCurrent: 'asc' },
  })

  // Group by installmentGroupId
  const groupMap = new Map<string, typeof entries>()
  for (const e of entries) {
    const gid = e.installmentGroupId!
    const arr = groupMap.get(gid) ?? []
    arr.push(e)
    groupMap.set(gid, arr)
  }

  let converted = 0

  for (const [groupId, group] of groupMap.entries()) {
    // Skip if any entry is already settled (partial payment — keep as installments)
    const hasSettled = await db.personEntry.count({ where: { installmentGroupId: groupId, isSettled: true } })
    if (hasSettled > 0) continue

    // Skip if a PersonEntryRecurring already exists for this person+description
    const first = group[0]
    const existing = await db.personEntryRecurring.findFirst({
      where: { userId: uid, personId: first.personId, description: first.description, isActive: true },
    })

    if (!existing) {
      // Create the recurring template
      const dayOfMonth = Math.min(new Date(first.date).getDate(), 28)
      await db.personEntryRecurring.create({
        data: {
          userId:      uid,
          personId:    first.personId,
          type:        first.type,
          description: first.description,
          amount:      first.amount,
          dayOfMonth,
          notes:       first.notes,
          categoryId:  first.categoryId,
          lastMonth:   format(now, 'yyyy-MM'), // already processed this month
        },
      })
    }

    // Find the closest upcoming entry (keep it, delete the rest)
    const upcoming = group.filter(e => new Date(e.date) >= now).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    const toKeep   = upcoming[0] ?? group[group.length - 1]

    // Update kept entry — remove installment metadata (make it a simple entry)
    await db.personEntry.update({
      where: { id: toKeep.id },
      data:  { installmentGroupId: null, installmentTotal: null, installmentCurrent: null },
    })

    // Delete all other entries in the group
    const toDeleteIds = group.filter(e => e.id !== toKeep.id).map(e => e.id)
    if (toDeleteIds.length > 0) {
      await db.personEntry.deleteMany({ where: { id: { in: toDeleteIds } } })
    }

    converted++
  }

  return ok(res, { converted, message: `${converted} grupo(s) convertido(s) para recorrente.` })
})
