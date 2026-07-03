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
  const y         = now.getFullYear()
  const m         = now.getMonth()
  const yearMonth = `${y}-${String(m + 1).padStart(2, '0')}`

  const templates = await db.personEntryRecurring.findMany({
    where: { userId: uid, isActive: true, OR: [{ lastMonth: null }, { lastMonth: { not: yearMonth } }] },
  })
  if (templates.length === 0) return

  for (const t of templates) {
    // No day-of-month gate: generate at month start, same as processRecurringBills
    // (CLAUDE.md: "Generation happens at month start … so all fixed bills are
    // visible from day 1"). The balance/projection math already counts an active
    // template's amount from day 1 whether or not its dayOfMonth has arrived, so
    // gating generation by the day produced a phantom debt in "Você deve" with no
    // Pendente card to pay it — exactly the state a deleted-then-reactivated
    // recurring entry lands in (its lastMonth is stale so it never regenerated).
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

// Same settle logic as POST /people/entries/[id]?action=settle — extracted to
// its own function so it's reusable without duplicating the Transaction
// creation + category-fallback logic (the recurring template's own entry, once
// generated, is settled through the normal entry the same way any other
// PersonEntry is — there's no separate "pay recurring template" path).
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
