import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, created, badRequest } from '@/lib/respond'

export default withAuth(async (req, res, session) => {
  const uid = session.userId

  if (req.method === 'GET') {
    const personId = req.query.personId as string | undefined
    const items = await db.personEntryRecurring.findMany({
      where:   { userId: uid, isActive: true, ...(personId ? { personId } : {}) },
      include: { person: { select: { id: true, name: true, color: true } }, category: { select: { id: true, name: true, icon: true, color: true } } },
      orderBy: { createdAt: 'desc' },
    })
    return ok(res, items)
  }

  if (req.method === 'POST') {
    const { personId, type, description, amount, dayOfMonth = 1, notes, categoryId } = req.body
    if (!personId || !type || !description || !amount) return badRequest(res, 'Campos obrigatórios faltando.')

    // Verify person belongs to user
    const person = await db.person.findFirst({ where: { id: personId, userId: uid } })
    if (!person) return badRequest(res, 'Pessoa não encontrada.')

    const item = await db.personEntryRecurring.create({
      data: {
        personId,
        userId:     uid,
        type,
        description,
        amount:     parseFloat(amount),
        dayOfMonth: Math.min(Math.max(parseInt(dayOfMonth), 1), 28),
        notes:      notes || null,
        categoryId: categoryId || null,
      },
      include: { person: { select: { id: true, name: true, color: true } }, category: { select: { id: true, name: true, icon: true, color: true } } },
    })
    return created(res, item)
  }

  return res.status(405).end()
})
