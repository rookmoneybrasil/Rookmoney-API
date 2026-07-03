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
  const now = new Date()
  const y   = now.getFullYear()
  const m   = now.getMonth()

  // Process ALL active templates on every load — do NOT skip by lastMonth.
  // lastMonth (an "already generated this month" flag) goes stale the moment a
  // generated entry is deleted, or was never set for entries created before the
  // recurringEntryId FK existed. A stale "already ran" flag is exactly what left
  // a template's amount counted in "Você deve" with no Pendente card to pay it.
  // Existence is decided per-template by ensureMonthEntry against the real entry
  // (via FK, with a heuristic adoption fallback), so this self-heals every load:
  // a missing card is regenerated, a legacy untagged entry is adopted, and an
  // already-linked one is left untouched. No day-of-month gate either (matches
  // processRecurringBills — CLAUDE.md: "Generation happens at month start … so
  // all fixed bills are visible from day 1"); the balance math already counts an
  // active template from day 1, so gating by the day produced the same phantom.
  const templates = await db.personEntryRecurring.findMany({
    where: { userId: uid, isActive: true },
  })
  if (templates.length === 0) return

  for (const t of templates) {
    await ensureMonthEntry(uid, t, y, m)
  }
}

// Guarantees exactly one PersonEntry links this template for the current month,
// creating or adopting as needed — no day-of-month gate.
async function ensureMonthEntry(
  uid: string,
  t: { id: string; personId: string; type: 'THEY_OWE_ME' | 'I_OWE_THEM'; description: string; amount: Prisma.Decimal; dayOfMonth: number; notes: string | null; categoryId: string | null },
  y: number,
  m: number,
) {
  const monthStart    = new Date(Date.UTC(y, m, 1))
  const monthEnd      = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59))
  const recurringMonth = `${y}-${String(m + 1).padStart(2, '0')}`

  // 1. Already linked this month → nothing to do.
  const exists = await db.personEntry.findFirst({
    where: { userId: uid, recurringEntryId: t.id, date: { gte: monthStart, lte: monthEnd } },
  })
  if (exists) return exists

  // 2. A matching entry exists this month but was never tagged with the FK
  //    (created before recurringEntryId existed, or by an older flow). Adopt it
  //    by setting the FK instead of creating a duplicate — otherwise the balance
  //    math can't tell it belongs to this template and double-counts the
  //    template's amount on top of it (the "Você deve mostra o valor mas nao tem
  //    card" bug when the paid entry is still in Acertados). Same person+
  //    description+type+month heuristic the backfill uses; prefer a settled one
  //    (real payment) over a pending duplicate.
  const orphan = await db.personEntry.findFirst({
    where: {
      userId: uid, personId: t.personId, type: t.type, description: t.description,
      installmentGroupId: null, recurringEntryId: null,
      date: { gte: monthStart, lte: monthEnd },
    },
    orderBy: [{ isSettled: 'desc' }, { createdAt: 'asc' }],
  })
  if (orphan) {
    try {
      return await db.personEntry.update({
        where: { id: orphan.id },
        data:  { recurringEntryId: t.id, recurringMonth },
      })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await db.personEntry.findFirst({ where: { userId: uid, recurringEntryId: t.id, recurringMonth } })
        if (winner) return winner
      }
      throw err
    }
  }

  // 3. Nothing exists → generate a fresh Pendente for this month.
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
