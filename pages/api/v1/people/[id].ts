import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, noContent, created, notFound } from '@/lib/respond'

export default withAuth(async (req, res, session) => {
  const id = req.query.id as string

  if (req.method === 'GET') {
    const person = await db.person.findFirst({
      where:   { id, userId: session.userId },
      include: { entries: { include: { category: { select: { id: true, name: true, icon: true, color: true } } }, orderBy: { date: 'desc' } } },
    })
    if (!person) return notFound(res)
    return ok(res, person)
  }

  if (req.method === 'POST' && req.query.action === 'entry') {
    const { type, description, amount, date, notes, categoryId, installments = 1, alreadyPaid = 0 } = req.body
    const numInstallments = parseInt(installments, 10) || 1
    const numAlreadyPaid  = Math.max(0, Math.min(parseInt(alreadyPaid, 10) || 0, numInstallments - 1))
    const [_y, _m, _d]   = (date as string).split('-').map(Number)
    // Use UTC noon to avoid timezone shifts across days (server in UTC, users in Brazil)
    const baseDate        = new Date(Date.UTC(_y, _m - 1, _d, 12, 0, 0))
    const amountNum       = parseFloat(amount) // amount is PER INSTALLMENT

    if (numInstallments <= 1) {
      const entry = await db.personEntry.create({
        data: { type, description, amount: amountNum, date: baseDate, notes: notes ?? null, categoryId: categoryId ?? null, personId: id, userId: session.userId },
        include: { category: { select: { id: true, name: true, icon: true, color: true } } },
      })
      return created(res, entry)
    }

    // Create only the REMAINING installments (skip already-paid ones)
    const { randomUUID } = await import('crypto')
    const groupId         = randomUUID()
    const remaining       = numInstallments - numAlreadyPaid

    const entries = await Promise.all(
      Array.from({ length: remaining }, (_, i) => {
        const current = numAlreadyPaid + i + 1
        // UTC noon to avoid timezone day-shift (Railway UTC vs Brazil UTC-3)
        const d = new Date(Date.UTC(_y, _m - 1 + i, _d, 12, 0, 0))
        return db.personEntry.create({
          data: {
            type, description,
            amount: amountNum,  // per installment value
            date:   d,
            notes:  notes ?? null,
            categoryId: categoryId ?? null,
            personId: id, userId: session.userId,
            installmentTotal:   numInstallments,
            installmentCurrent: current,
            installmentGroupId: groupId,
          },
          include: { category: { select: { id: true, name: true, icon: true, color: true } } },
        })
      })
    )
    return created(res, entries[0])
  }

  if (req.method === 'PATCH') {
    const person = await db.person.findFirst({ where: { id, userId: session.userId } })
    if (!person) return notFound(res)
    const updated = await db.person.update({ where: { id }, data: req.body })
    return ok(res, updated)
  }

  if (req.method === 'DELETE') {
    await db.person.deleteMany({ where: { id, userId: session.userId } })
    return noContent(res)
  }

  return res.status(405).end()
})
