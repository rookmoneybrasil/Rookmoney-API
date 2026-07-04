import { db } from '@/lib/db'
import { Prisma } from '@/generated/prisma/client'

// Generates this month's Bill for every active RecurringBill template — mirrors
// processRecurringPersonEntries. Existence is decided per-template against the
// real Bill (via the recurringBillId FK, with a heuristic adoption fallback), so
// it self-heals every load: deleting the current month's bill (e.g. undoing a
// payment) makes the next load recreate a pending one — that's what lets the
// recurring card reactivate. Do NOT gate by lastAutoMonth (it goes stale on
// delete and was the old "skip this month" flag). No day-of-month gate either;
// generation happens at month start so the bill is visible from day 1.
export async function processRecurringBills(uid: string): Promise<void> {
  const now = new Date()
  const y   = now.getFullYear()
  const m   = now.getMonth()
  const yearMonth = `${y}-${String(m + 1).padStart(2, '0')}`

  const templates = await db.recurringBill.findMany({
    where: { userId: uid, isActive: true },
  })
  if (templates.length === 0) return

  for (const t of templates) {
    // Respect the template's start month: a fixed bill whose "1ª data" is in a
    // future month must not generate (or count) until that month. null = legacy
    // template that starts immediately.
    if (t.startMonth && yearMonth < t.startMonth) continue
    // Isolate each template: a failure on one must NOT abort generating the rest.
    try {
      await ensureMonthBill(uid, t, y, m)
    } catch (err) {
      console.error(`[process-recurring-bills] ensureMonthBill failed for template ${t.id} (user ${uid}):`, err)
    }
  }
}

// Guarantees exactly one Bill links this template for the current month —
// creating or adopting as needed, no day-of-month gate.
async function ensureMonthBill(
  uid: string,
  t: { id: string; name: string; amount: Prisma.Decimal; dayOfMonth: number; notes: string | null; categoryId: string | null },
  y: number,
  m: number,
) {
  const monthStart     = new Date(Date.UTC(y, m, 1))
  const monthEnd       = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59))
  const recurringMonth = `${y}-${String(m + 1).padStart(2, '0')}`

  // Already linked this month → nothing to do. (No adoption-by-name step like
  // the Pessoas generator: bills were ALWAYS created with recurringBillId set,
  // so there are no untagged legacy recurring bills to adopt — and matching by
  // name alone could wrongly grab an unrelated one-off bill of the same name.)
  const exists = await db.bill.findFirst({
    where: { userId: uid, recurringBillId: t.id, dueDate: { gte: monthStart, lte: monthEnd } },
  })
  if (exists) return exists

  // Nothing exists → generate a fresh pending Bill for this month.
  const day     = Math.min(t.dayOfMonth, new Date(y, m + 1, 0).getDate())
  const dueDate = new Date(Date.UTC(y, m, day, 12, 0, 0))
  try {
    return await db.bill.create({
      data: {
        name:            t.name,
        amount:          t.amount,
        dueDate,
        isRecurring:     false,
        userId:          uid,
        categoryId:      t.categoryId ?? null,
        notes:           t.notes ?? null,
        recurringBillId: t.id,
        recurringMonth,
      },
    })
  } catch (err) {
    // Unique on (recurringBillId, recurringMonth) — a concurrent request (the
    // dashboard auto-process and the bills page rendering together, or a cron
    // overlapping a load) won the race and created it first. Use that one.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await db.bill.findFirst({ where: { userId: uid, recurringBillId: t.id, recurringMonth } })
      if (winner) return winner
    }
    throw err
  }
}
