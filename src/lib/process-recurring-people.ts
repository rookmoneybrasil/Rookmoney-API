import { db } from '@/lib/db'
import { Prisma } from '@/generated/prisma/client'

// Generates this month's PersonEntry for every active PersonEntryRecurring
// template that hasn't been processed yet, mirroring processRecurringBills —
// checks existence via the recurringEntryId FK before creating (the old
// lastMonth-only gate had no existence check, which is what let the manual
// "Pago" button and the cron both create an entry for the same template in
// the same month — see the 2026-06-03-dedup-recurring-person-entries data
// migration for the historical duplicate cleanup this replaces).
export async function processRecurringPersonEntries(uid: string): Promise<void> {
  const now       = new Date()
  const today     = now.getDate()
  const y         = now.getFullYear()
  const m         = now.getMonth()
  const yearMonth = `${y}-${String(m + 1).padStart(2, '0')}`

  const templates = await db.personEntryRecurring.findMany({
    where: { userId: uid, isActive: true, OR: [{ lastMonth: null }, { lastMonth: { not: yearMonth } }] },
  })
  if (templates.length === 0) return

  for (const t of templates) {
    if (today < t.dayOfMonth) continue
    await ensureMonthEntry(uid, t, y, m)
    await db.personEntryRecurring.update({ where: { id: t.id }, data: { lastMonth: yearMonth } })
  }
}

// Ensures a PersonEntry exists for this template this month, WITHOUT the
// day-of-month gate (used by the "pay" action — the user explicitly wants it
// now, regardless of whether processRecurringPersonEntries would have created
// it yet) and without touching lastMonth by itself — the caller decides.
async function ensureMonthEntry(
  uid: string,
  t: { id: string; personId: string; type: 'THEY_OWE_ME' | 'I_OWE_THEM'; description: string; amount: Prisma.Decimal; dayOfMonth: number; notes: string | null; categoryId: string | null },
  y: number,
  m: number,
) {
  const monthStart    = new Date(Date.UTC(y, m, 1))
  const monthEnd      = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59))
  const recurringMonth = `${y}-${String(m + 1).padStart(2, '0')}`

  const exists = await db.personEntry.findFirst({
    where: { userId: uid, recurringEntryId: t.id, date: { gte: monthStart, lte: monthEnd } },
  })
  if (exists) return exists

  const day       = Math.min(t.dayOfMonth, new Date(y, m + 1, 0).getDate())
  const entryDate = new Date(Date.UTC(y, m, day, 12, 0, 0))

  try {
    return await db.personEntry.create({
      data: {
        personId:         t.personId,
        userId:           uid,
        type:             t.type,
        description:      t.description,
        amount:           t.amount,
        date:             entryDate,
        notes:            t.notes,
        categoryId:       t.categoryId,
        recurringEntryId: t.id,
        recurringMonth,
      },
    })
  } catch (err) {
    // Unique constraint on (recurringEntryId, recurringMonth) — a concurrent
    // request (e.g. the dashboard's auto-process and a "pay" click landing at
    // the same instant) won the race and created it first. Fetch and use that
    // one instead of a duplicate.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await db.personEntry.findFirst({
        where: { userId: uid, recurringEntryId: t.id, recurringMonth },
      })
      if (winner) return winner
    }
    throw err
  }
}

// Used by the "pay recurring template" endpoint: guarantees the month's
// entry exists (creating it if the day-of-month gate hasn't been hit yet by
// the cron/dashboard auto-process), marks lastMonth so it isn't re-created
// later, and settles it — same effect as the old "create ad-hoc entry + settle"
// button flow, but through the FK so there's never more than one entry per
// template per month.
export async function payRecurringPersonEntry(uid: string, recurringId: string) {
  const t = await db.personEntryRecurring.findFirst({ where: { id: recurringId, userId: uid } })
  if (!t) return null

  const now       = new Date()
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

  const entry = await ensureMonthEntry(uid, t, now.getFullYear(), now.getMonth())
  if (t.lastMonth !== yearMonth) {
    await db.personEntryRecurring.update({ where: { id: t.id }, data: { lastMonth: yearMonth } })
  }
  if (entry.isSettled) return entry

  return settlePersonEntry(uid, entry.id)
}

// Same settle logic as POST /people/entries/[id]?action=settle — extracted so
// payRecurringPersonEntry can reuse it without duplicating the Transaction
// creation + category-fallback logic.
export async function settlePersonEntry(uid: string, entryId: string) {
  const entry = await db.personEntry.findFirst({
    where:   { id: entryId, userId: uid },
    include: { person: { select: { name: true } } },
  })
  if (!entry || entry.isSettled) return entry

  const txType = entry.type === 'I_OWE_THEM' ? 'EXPENSE' : 'INCOME'
  const categoryId = entry.categoryId ?? (
    await db.category.findFirst({
      where:   { OR: [{ isDefault: true }, { userId: uid }] },
      orderBy: { isDefault: 'desc' },
    })
  )?.id ?? null
  if (!categoryId) throw new Error('Nenhuma categoria encontrada. Configure uma categoria padrão.')

  const personName    = entry.person?.name
  const txDescription = personName ? `${entry.description} (${personName})` : entry.description

  const tx = await db.transaction.create({
    data: {
      amount:      entry.amount,
      type:        txType,
      description: txDescription,
      date:        new Date(),
      userId:      uid,
      categoryId,
    },
  })

  return db.personEntry.update({
    where: { id: entryId },
    data:  { isSettled: true, settledAt: new Date(), settledTransactionId: tx.id },
  })
}
