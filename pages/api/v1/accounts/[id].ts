import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, noContent, notFound, badRequest } from '@/lib/respond'

const TYPES = ['CASH', 'CHECKING', 'SAVINGS', 'CREDIT_CARD'] as const

export default withAuth(async (req, res, session) => {
  const id = req.query.id as string
  const account = await db.account.findFirst({ where: { id, userId: session.userId } })
  if (!account) return notFound(res)

  if (req.method === 'PATCH' || req.method === 'PUT') {
    const { name, type, icon, color, initialBalance, archived, isDefault } = req.body

    // Making this the default clears the flag on the others (only one default).
    if (isDefault === true) {
      await db.account.updateMany({ where: { userId: session.userId, isDefault: true }, data: { isDefault: false } })
    }

    const updated = await db.account.update({
      where: { id },
      data: {
        ...(name           !== undefined && { name: String(name).trim() }),
        ...(type           !== undefined && TYPES.includes(type) && { type }),
        ...(icon           !== undefined && { icon }),
        ...(color          !== undefined && { color }),
        ...(initialBalance !== undefined && { initialBalance: Number(initialBalance) }),
        ...(archived       !== undefined && { archived: Boolean(archived) }),
        ...(isDefault === true && { isDefault: true }),
      },
    })
    return ok(res, updated)
  }

  if (req.method === 'DELETE') {
    // Keep at least one account — deleting the last would leave payments with
    // nowhere to land.
    const count = await db.account.count({ where: { userId: session.userId } })
    if (count <= 1) return badRequest(res, 'Você precisa ter pelo menos uma conta.')

    // Reassign this account's transactions to another account (the default, or
    // the oldest other one) BEFORE deleting — otherwise the FK's onDelete:
    // SetNull would orphan them and the total balance would silently drop by
    // this account's balance. The movements really happened; they just move
    // homes.
    const fallback = await db.account.findFirst({
      where:   { userId: session.userId, id: { not: id } },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      select:  { id: true },
    })
    if (fallback) {
      await db.transaction.updateMany({
        where: { accountId: id, userId: session.userId },
        data:  { accountId: fallback.id },
      })
      // The opening balance has to move with the transactions. Balance is
      // computed (initialBalance + Σ transactions), so deleting the account
      // without carrying its initialBalance over makes the TOTAL silently drop
      // by that amount — money vanishing from the user's screen, which is the
      // same failure the reassignment above exists to prevent.
      if (Number(account.initialBalance) !== 0) {
        await db.account.update({
          where: { id: fallback.id },
          data:  { initialBalance: { increment: account.initialBalance } },
        })
      }
    }

    await db.account.delete({ where: { id } })

    // If we removed the default, promote the oldest remaining account.
    if (account.isDefault) {
      const next = await db.account.findFirst({ where: { userId: session.userId }, orderBy: { createdAt: 'asc' } })
      if (next) await db.account.update({ where: { id: next.id }, data: { isDefault: true } })
    }
    return noContent(res)
  }

  return res.status(405).end()
})
