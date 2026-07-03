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
  // ─── 2026-06-18 ─────────────────────────────────────────────────────
  {
    id:  '2026-06-18-backfill-achievements',
    run: async (db) => {
      // Grant retroactive achievements to existing users based on their current data.
      // Only checks fast-to-verify achievements to avoid timeout on large user sets.
      const users = await db.user.findMany({ select: { id: true, createdAt: true, profileImage: true, name: true, email: true } })

      for (const user of users) {
        const userId = user.id
        const toInsert: string[] = []

        // Welcome — everyone gets it
        toInsert.push('welcome')

        // Volume checks (fast counts)
        const [billCount, txCount, goalCount, incomeCount, personCount, contribCount] = await Promise.all([
          db.bill.count({ where: { userId } }),
          db.transaction.count({ where: { userId } }),
          db.goal.count({ where: { userId } }),
          db.incomeSource.count({ where: { userId } }),
          db.person.count({ where: { userId } }),
          db.goalContribution.count({ where: { goal: { userId } } }),
        ])

        if (billCount >= 1)   toInsert.push('first-bill')
        if (billCount >= 10)  toInsert.push('10-bills')
        if (billCount >= 50)  toInsert.push('50-bills')
        if (billCount >= 100) toInsert.push('100-bills')
        if (billCount >= 500) toInsert.push('500-bills')

        if (txCount >= 1)   toInsert.push('first-transaction', 'first-account')
        if (txCount >= 50)  toInsert.push('50-transactions')
        if (txCount >= 200) toInsert.push('200-transactions')
        if (txCount >= 500) toInsert.push('500-transactions')

        if (goalCount >= 1) toInsert.push('first-goal')
        if (incomeCount >= 1) toInsert.push('first-income')
        if (incomeCount >= 3) toInsert.push('multi-income')
        if (incomeCount >= 5) toInsert.push('diversified')

        if (contribCount >= 1)  toInsert.push('first-deposit')
        if (contribCount >= 5)  toInsert.push('steady')
        if (contribCount >= 20) toInsert.push('dedicated')
        if (contribCount >= 50) toInsert.push('obsessive')

        if (user.name && user.email && user.profileImage) toInsert.push('complete-profile')

        const recurringCount = await db.recurringBill.count({ where: { userId, isActive: true } })
        if (recurringCount >= 1)  toInsert.push('autopilot')
        if (recurringCount >= 10) toInsert.push('full-autopilot')

        const completedGoals = await db.goal.count({ where: { userId, isCompleted: true } })
        if (completedGoals >= 1)  toInsert.push('goal-reached')
        if (completedGoals >= 3)  toInsert.push('dream-collector')
        if (completedGoals >= 5)  toInsert.push('achiever')
        if (completedGoals >= 10) toInsert.push('dream-machine')

        // Account age
        const ageDays = (Date.now() - new Date(user.createdAt).getTime()) / (24 * 60 * 60 * 1000)
        if (ageDays >= 90)  toInsert.push('veteran')
        if (ageDays >= 180) toInsert.push('rooted')
        if (ageDays >= 365) toInsert.push('legendary')
        if (ageDays >= 730) toInsert.push('eternal')

        const final = [...new Set(toInsert)]
        if (final.length > 0) {
          for (const slug of final) {
            await db.userAchievement.create({ data: { userId, slug, seen: true } }).catch(() => { /* duplicate — already exists */ })
          }
        }
      }
    },
  },

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
        const day    = Math.min(new Date(latest.dueDate).getUTCDate(), 31)

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

  // ─── 2026-06-03 ─────────────────────────────────────────────────────
  {
    id:  '2026-06-03-dedup-recurring-person-entries',
    run: async (db) => {
      // The old "Pago" button on RecurringEntryCard created a NEW PersonEntry
      // instead of settling the existing generated one. This left duplicate
      // unsettled entries (same person + description + month). Keep the oldest
      // (generated by cron) and delete the duplicates created by the button.
      const entries = await db.personEntry.findMany({
        where:   { isSettled: false, installmentGroupId: null },
        orderBy: { createdAt: 'asc' },
        select:  { id: true, personId: true, userId: true, type: true, description: true, amount: true, date: true, createdAt: true },
      })

      // Group by userId + personId + description + type + year-month
      const groups = new Map<string, typeof entries>()
      for (const e of entries) {
        const month = `${new Date(e.date).getFullYear()}-${String(new Date(e.date).getMonth() + 1).padStart(2, '0')}`
        const key   = `${e.userId}::${e.personId}::${e.description}::${e.type}::${month}`
        const arr   = groups.get(key) ?? []
        arr.push(e)
        groups.set(key, arr)
      }

      const toDelete: string[] = []
      for (const [, group] of groups.entries()) {
        if (group.length <= 1) continue
        // Keep the first (oldest/cron-generated), delete the rest
        toDelete.push(...group.slice(1).map(e => e.id))
      }

      if (toDelete.length > 0) {
        await db.personEntry.deleteMany({ where: { id: { in: toDelete } } })
        console.log(`[data-migration] dedup: removed ${toDelete.length} duplicate person entries`)
      }
    },
  },

  // ─── 2026-06-03 ─────────────────────────────────────────────────────
  {
    id:  '2026-06-03-invalidate-plain-text-reset-tokens',
    run: async (db) => {
      // passwordResetToken now stores SHA-256 hashes.
      // Any existing plain-text tokens are invalid — clear them so users
      // can't use old unscoped links. They'll request a new reset link.
      await db.user.updateMany({
        where: { passwordResetToken: { not: null } },
        data:  { passwordResetToken: null, passwordResetExpiry: null },
      })
    },
  },

  // ─── 2026-06-03 ─────────────────────────────────────────────────────
  {
    id:  '2026-06-03-clear-test-stripe-customer-ids',
    run: async (db) => {
      // When we switched from Stripe test mode to production, some users
      // had test-mode stripeCustomerId (cus_...) stored. These are invalid
      // in production. Clear them so the billing portal check works correctly.
      // Users will get a new customerId when they subscribe in production.
      await db.user.updateMany({
        where: { stripeCustomerId: { not: null } },
        data:  { stripeCustomerId: null, stripeSubscriptionId: null },
      })
    },
  },

  // ─── 2026-06-24 ─────────────────────────────────────────────────────
  {
    id:  '2026-06-24-cleanup-phantom-withdraw-income',
    run: async (db) => {
      const deleted = await db.transaction.deleteMany({
        where: {
          type: 'INCOME',
          description: { startsWith: 'Retirada — ' },
        },
      })
      if (deleted.count > 0) {
        console.log(`[data-migration] cleaned ${deleted.count} phantom withdrawal INCOME transactions`)
      }
    },
  },

  // ─── 2026-06-28 ─────────────────────────────────────────────────────
  {
    id:  '2026-06-28-fix-blog-year-2024',
    run: async (db) => {
      const posts = await db.blogPost.findMany({
        where: {
          source: 'ai-generated',
          OR: [
            { title: { contains: '2024' } },
            { excerpt: { contains: '2024' } },
            { content: { contains: '2024' } },
          ],
        },
      })
      for (const post of posts) {
        await db.blogPost.update({
          where: { id: post.id },
          data: {
            title:   post.title.replaceAll('2024', '2026'),
            excerpt: post.excerpt.replaceAll('2024', '2026'),
            content: post.content.replaceAll('2024', '2026'),
            slug:    post.slug.includes('2024') ? post.slug.replaceAll('2024', '2026') : post.slug,
          },
        })
      }
    },
  },

  // ─── 2026-06-05 ─────────────────────────────────────────────────────
  {
    id:  '2026-06-05-revert-future-startdate-income',
    run: async (db) => {
      // Reverts income transactions incorrectly created for sources with a future startDate.
      // This happened because processAutoIncome() didn't check startDate before this fix.
      const now        = new Date()
      const yearMonth  = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
      const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)

      const sources = await db.incomeSource.findMany({
        where: {
          startDate:        { gt: now },    // startDate is in the future
          lastAutoPayMonth: yearMonth,      // but was processed this month (bug)
        },
      })

      for (const src of sources) {
        await db.transaction.deleteMany({
          where: {
            userId:      src.userId,
            type:        'INCOME',
            description: src.name,
            date:        { gte: monthStart, lte: monthEnd },
          },
        })
        await db.incomeSource.update({
          where: { id: src.id },
          data:  { lastAutoPayMonth: null },
        })
      }
    },
  },

  // ─── 2026-07-03 ─────────────────────────────────────────────────────
  {
    id:  '2026-07-03-backfill-person-recurring-fk',
    run: (db) => backfillPersonRecurringFk(db),
  },

  // ─── 2026-07-03b ────────────────────────────────────────────────────
  {
    id:  '2026-07-03b-backfill-person-recurring-fk',
    // Re-runs the same backfill: POST /people/recurring's "create first entry
    // immediately" path (firstDate today/past) forgot to set recurringEntryId
    // on that entry, so every recurring created through it after the first
    // backfill ran (which only fixes rows once, per migration id) stayed
    // unmatched and had its full template amount double-counted as debt on
    // top of the entry itself. That endpoint now sets the FK on creation;
    // this just catches rows created in the gap before that fix landed.
    run: (db) => backfillPersonRecurringFk(db),
  },

  // ─── 2026-07-03c ────────────────────────────────────────────────────
  {
    id:  '2026-07-03c-backfill-person-recurring-fk',
    // Rounds 1-2 skipped any template+month group with 3+ unlinked candidate
    // entries entirely — no recurringEntryId set on ANY of them, "needs manual
    // review". That left the settled entry in those groups permanently
    // invisible to the "does this template already have an entry this month"
    // check: pausing a template hid it correctly (paused templates are
    // excluded from the check altogether), but reactivating made its full
    // amount get double-counted on top of the entry that's already sitting in
    // Acertados, with no new card ever appearing (nothing was created — the
    // existing entry just isn't tagged). Round 3 tags the settled entry in an
    // ambiguous group (never the unsettled ones — which one of several
    // pending entries is "the" recurring instance is still genuinely
    // ambiguous) without deleting anything, closing that hole.
    run: (db) => backfillPersonRecurringFk(db, { tagSettledInAmbiguousGroups: true }),
  },
]

async function backfillPersonRecurringFk(db: PrismaClient, opts: { tagSettledInAmbiguousGroups?: boolean } = {}) {
  // PersonEntry gained a real recurringEntryId FK (mirrors Bill.recurringBillId)
  // to replace the description/type/date heuristic that matched entries to
  // their PersonEntryRecurring template. Backfill it for existing entries by
  // running that same heuristic here. Where the old heuristic finds more than
  // one entry for the same template+month (the exact duplicate-creation bug
  // that 2026-06-03-dedup-recurring-person-entries cleaned up once already —
  // the button and the cron could each create their own entry since neither
  // checked for an existing one), keep one and delete the rest — but NEVER
  // delete a settled entry: unlike the pending duplicates this is cleaning up,
  // a settled entry has a real Transaction behind it, and if two happen to
  // exist (e.g. paid twice by mistake before this fix) deleting either one
  // would silently erase real payment history. Only unsettled duplicates are
  // ever removed.
  const templates = await db.personEntryRecurring.findMany()

  for (const t of templates) {
    const candidates = await db.personEntry.findMany({
      where: {
        userId:      t.userId,
        personId:    t.personId,
        description: t.description,
        type:        t.type,
        installmentGroupId: null,
        recurringEntryId:   null,
      },
      orderBy: { createdAt: 'asc' },
    })
    if (candidates.length === 0) continue

    const byMonth = new Map<string, typeof candidates>()
    for (const e of candidates) {
      const d   = new Date(e.date)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      const arr = byMonth.get(key) ?? []
      arr.push(e)
      byMonth.set(key, arr)
    }

    for (const [monthKey, group] of byMonth.entries()) {
      // The known bug (button + cron both creating an entry, neither
      // checking for an existing one) always produces exactly 2 matches
      // for a given template+month. 3+ matches is no longer that specific
      // signature — more likely an unrelated one-off entry that happens to
      // share the same person+description+type coincidentally mixed in.
      // Don't guess which to delete in that case; just log it for manual
      // review and leave every entry untouched (no recurringEntryId tag
      // either, so nothing here risks misattributing an unrelated entry).
      if (group.length > 2) {
        // Never delete anything here (still too ambiguous which of several
        // entries is "the" recurring instance) — but if exactly one of them
        // is settled, tagging just that one is safe regardless of the
        // ambiguity: a settled entry matching this template's person+
        // description+type+month is unambiguously this month's payment for
        // it, and tagging it doesn't touch or hide any of the other entries.
        const settledOnes = group.filter(e => e.isSettled)
        if (opts.tagSettledInAmbiguousGroups && settledOnes.length === 1) {
          await db.personEntry.update({ where: { id: settledOnes[0].id }, data: { recurringEntryId: t.id, recurringMonth: monthKey } })
          console.log(`[data-migration] backfill-person-recurring-fk: tagged settled entry in ambiguous group of ${group.length} for template ${t.id}, month ${monthKey} (others left untouched)`)
        } else {
          console.warn(`[data-migration] backfill-person-recurring-fk: skipping ambiguous group of ${group.length} entries for template ${t.id}, month ${monthKey} — needs manual review`)
        }
        continue
      }

      const keep = group.find(e => e.isSettled) ?? group[0]
      // Only ever delete unsettled duplicates — settled entries (and their
      // real Transaction) are left untouched even if more than one exists.
      const toDelete = group.filter(e => e.id !== keep.id && !e.isSettled)

      // Also set recurringMonth (not just recurringEntryId) so the unique
      // constraint that prevents future duplicates actually covers this
      // backfilled row too.
      await db.personEntry.update({ where: { id: keep.id }, data: { recurringEntryId: t.id, recurringMonth: monthKey } })

      if (toDelete.length > 0) {
        const txIds = toDelete.map(e => e.settledTransactionId).filter((id): id is string => Boolean(id))
        await db.personEntry.deleteMany({ where: { id: { in: toDelete.map(e => e.id) } } })
        if (txIds.length > 0) {
          await db.transaction.deleteMany({ where: { id: { in: txIds } } })
        }
        console.log(`[data-migration] backfill-person-recurring-fk: removed ${toDelete.length} duplicate(s) for template ${t.id}`)
      }
    }
  }
}

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
