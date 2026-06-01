/**
 * Data Migrations — one-time data transformations tracked in the DataMigration table.
 *
 * HOW TO ADD A NEW MIGRATION:
 *   1. Add a new entry to MIGRATIONS below (keep them in chronological order)
 *   2. Use a unique `id` in the format "YYYY-MM-DD-description"
 *   3. The `run` function receives the Prisma client and must be idempotent
 *      (safe to run multiple times with no side effects if it already ran)
 *   4. The runner marks it as done after success — it will NEVER run again
 *
 * Migrations run automatically on the first request after a deploy
 * (called from api/src/lib/startup.ts, triggered by db.ts import).
 */

import type { PrismaClient } from '../generated/prisma/client'

interface Migration {
  id:  string
  run: (db: PrismaClient) => Promise<void>
}

const MIGRATIONS: Migration[] = [
  // ─── 2026-06-02 ─────────────────────────────────────────────────────
  {
    id:  '2026-06-02-migrate-recurring-bills',
    run: async (db) => {
      // Converts old Bill.isRecurring=true records into RecurringBill templates.
      // Groups bills by (userId, name) — each unique name becomes one template.
      // Links existing bills to their template via recurringBillId.
      const bills = await db.bill.findMany({
        where:   { isRecurring: true, recurringBillId: null },
        orderBy: { dueDate: 'desc' },
      })

      const byUserName = new Map<string, typeof bills>()
      for (const b of bills) {
        const key = `${b.userId}::${b.name}`
        const arr = byUserName.get(key) ?? []
        arr.push(b)
        byUserName.set(key, arr)
      }

      for (const [, group] of byUserName.entries()) {
        const latest = group[0]
        const day    = Math.min(new Date(latest.dueDate).getUTCDate(), 28)

        const template = await db.recurringBill.create({
          data: {
            name:       latest.name,
            amount:     latest.amount,
            dayOfMonth: day,
            userId:     latest.userId,
            categoryId: latest.categoryId ?? null,
            notes:      latest.notes ?? null,
          },
        })

        await db.bill.updateMany({
          where: { id: { in: group.map(b => b.id) } },
          data:  { recurringBillId: template.id, isRecurring: false },
        })
      }
    },
  },

  // ─── Add future migrations below ────────────────────────────────────
  // {
  //   id:  'YYYY-MM-DD-description',
  //   run: async (db) => { ... },
  // },
]

// ─── Runner ──────────────────────────────────────────────────────────────────

let started = false // module-level: prevents duplicate runs within the same process

export async function runDataMigrations(db: PrismaClient): Promise<void> {
  if (started) return
  started = true

  try {
    const done = new Set(
      (await db.dataMigration.findMany({ select: { id: true } })).map(m => m.id)
    )

    for (const migration of MIGRATIONS) {
      if (done.has(migration.id)) continue

      try {
        await migration.run(db)
        await db.dataMigration.create({ data: { id: migration.id } })
        console.log(`[data-migration] ✓ ${migration.id}`)
      } catch (err) {
        // Log but don't crash — a failed migration will retry on next deploy
        console.error(`[data-migration] ✗ ${migration.id}:`, err)
        started = false // allow retry on next request
      }
    }
  } catch (err) {
    console.error('[data-migration] runner failed:', err)
    started = false
  }
}
