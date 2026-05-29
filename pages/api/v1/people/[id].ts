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
    const { type, description, amount, date, notes, categoryId, installments = 1 } = req.body
    const numInstallments = parseInt(installments, 10) || 1
    const [_y, _m, _d]   = (date as string).split('-').map(Number)
    const baseDate        = new Date(_y, _m - 1, _d)
    const amountNum       = parseFloat(amount)

    if (numInstallments <= 1) {
      // Single entry
      const entry = await db.personEntry.create({
        data: { type, description, amount: amountNum, date: baseDate, notes: notes ?? null, categoryId: categoryId ?? null, personId: id, userId: session.userId },
        include: { category: { select: { id: true, name: true, icon: true, color: true } } },
      })
      return created(res, entry)
    }

    // Multiple installments — create grouped entries
    const { randomUUID } = await import('crypto')
    const groupId         = randomUUID()
    const perInstallment  = Math.round((amountNum / numInstallments) * 100) / 100

    const entries = await Promise.all(
      Array.from({ length: numInstallments }, (_, i) => {
        const d = new Date(baseDate.getFullYear(), baseDate.getMonth() + i, baseDate.getDate())
        return db.personEntry.create({
          data: {
            type, description,
            amount: perInstallment,
            date:   d,
            notes:  notes ?? null,
            categoryId: categoryId ?? null,
            personId: id, userId: session.userId,
            installmentTotal:   numInstallments,
            installmentCurrent: i + 1,
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
