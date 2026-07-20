import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, noContent, notFound, badRequest } from '@/lib/respond'
import { checkAchievements } from '@/lib/achievement-checker'
import { resolveFallbackCategoryId } from '@/lib/category-fallback'
import { resolveDefaultAccountId } from '@/lib/account-balances'

export default withAuth(async (req, res, session) => {
  const id = req.query.id as string

  // ── POST /api/v1/bills/:id?action=pay ─────────────────────────────────────
  if (req.method === 'POST' && req.query.action === 'pay') {
    const bill = await db.bill.findFirst({ where: { id, userId: session.userId } })
    if (!bill) return notFound(res)
    const { paid = true } = req.body

    if (paid && !bill.isPaid) {
      // Resolve categoryId before mutating anything (fail cleanly if missing).
      const categoryId = bill.categoryId ?? (await resolveFallbackCategoryId(session.userId))

      if (!categoryId) return badRequest(res, 'Nenhuma categoria encontrada. Configure uma categoria padrão.')

      // Atomic claim (WHERE isPaid=false): a double-tap or race firing this
      // endpoint twice must only ever create ONE Transaction. Postgres takes a
      // row lock during the UPDATE, so a concurrent claim either matches 0 rows
      // (lost the race) or blocks until the first commits, then re-checks the
      // WHERE — never both succeed.
      const claim = await db.bill.updateMany({
        where: { id, userId: session.userId, isPaid: false },
        data:  { isPaid: true, paidAt: new Date() },
      })
      if (claim.count === 0) {
        const current = await db.bill.findFirst({ where: { id, userId: session.userId } })
        return ok(res, current)
      }

      const tx = await db.transaction.create({
        data: {
          amount:      bill.amount,
          type:        'EXPENSE',
          description: bill.name,
          date:        new Date(),
          userId:      session.userId,
          categoryId,
          accountId:   await resolveDefaultAccountId(session.userId),
        },
      })
      const updated = await db.bill.update({ where: { id }, data: { paidTransactionId: tx.id } })
      checkAchievements(db, session.userId, 'pay-bill', { billId: id }).catch(() => {})
      return ok(res, updated)
    }

    if (!paid && bill.isPaid) {
      // Same atomic claim on the way back, so a double-tap "unpay" doesn't
      // double-delete/duplicate-clear the linked transaction.
      const claim = await db.bill.updateMany({
        where: { id, userId: session.userId, isPaid: true },
        data:  { isPaid: false, paidAt: null, paidTransactionId: null },
      })
      if (claim.count === 0) {
        const current = await db.bill.findFirst({ where: { id, userId: session.userId } })
        return ok(res, current)
      }
      if (bill.paidTransactionId) {
        await db.transaction.deleteMany({ where: { id: bill.paidTransactionId, userId: session.userId } })
      }
      const updated = await db.bill.findFirst({ where: { id, userId: session.userId } })
      return ok(res, updated)
    }

    // No change needed (already in desired state)
    return ok(res, bill)
  }

  const bill = await db.bill.findFirst({ where: { id, userId: session.userId } })
  if (!bill) return notFound(res)

  if (req.method === 'GET') return ok(res, bill)

  if (req.method === 'PUT' || req.method === 'PATCH') {
    const { name, amount, dueDate, isRecurring, categoryId, notes } = req.body
    const updated = await db.bill.update({
      where: { id },
      data: {
        ...(name        !== undefined && { name }),
        ...(amount      !== undefined && { amount: parseFloat(amount) }),
        ...(dueDate !== undefined && dueDate && (() => {
          const [y, m, d] = (dueDate as string).split('-').map(Number)
          return { dueDate: new Date(Date.UTC(y, m - 1, d, 12, 0, 0)) }
        })()),
        ...(isRecurring !== undefined && { isRecurring }),
        ...(categoryId  !== undefined && { categoryId: categoryId || null }),
        ...(notes       !== undefined && { notes: notes || null }),
      },
    })

    // If this bill was already paid, re-file its generated Transaction to the
    // new category too (only the category — value/description stay as the
    // historical record). Same fix as the recurring template PATCH.
    if (categoryId !== undefined && bill.paidTransactionId) {
      const txCategoryId = categoryId || (await resolveFallbackCategoryId(session.userId))
      if (txCategoryId) {
        await db.transaction.updateMany({
          where: { id: bill.paidTransactionId, userId: session.userId },
          data:  { categoryId: txCategoryId },
        })
      }
    }
    return ok(res, updated)
  }

  if (req.method === 'DELETE') {
    // Granular delete for installment parcelas (?scope=one|future|all).
    // 'one' (default) = just this bill; 'future' = this + every later parcela of
    // the same group (dueDate >= this); 'all' = the whole group. Non-installment
    // bills ignore scope and delete only themselves. Linked paid transactions of
    // every targeted bill are removed too.
    const scope = (req.query.scope as string) || 'one'
    if (bill.installmentGroupId && (scope === 'future' || scope === 'all')) {
      const where = scope === 'all'
        ? { installmentGroupId: bill.installmentGroupId, userId: session.userId }
        : { installmentGroupId: bill.installmentGroupId, userId: session.userId, dueDate: { gte: bill.dueDate } }
      const targeted = await db.bill.findMany({ where, select: { paidTransactionId: true } })
      const txIds = targeted.map(b => b.paidTransactionId).filter((v): v is string => !!v)
      if (txIds.length > 0) {
        await db.transaction.deleteMany({ where: { id: { in: txIds }, userId: session.userId } })
      }
      await db.bill.deleteMany({ where })
      return noContent(res)
    }

    if (bill.paidTransactionId) {
      await db.transaction.deleteMany({ where: { id: bill.paidTransactionId, userId: session.userId } })
    }
    await db.bill.deleteMany({ where: { id, userId: session.userId } })

    // NOTE: we intentionally do NOT touch the template's lastAutoMonth here.
    // processRecurringBills no longer gates by lastAutoMonth — it checks the
    // real Bill every load. So deleting THIS month's bill (e.g. undoing a
    // payment from the recurring card) makes the next load recreate a pending
    // one → the card reactivates. Deleting a PAST month's bill just removes it
    // (the generator only ever touches the current month).

    return noContent(res)
  }

  return res.status(405).end()
})
