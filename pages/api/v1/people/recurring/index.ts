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
    const { personId, type, description, amount, dayOfMonth = 1, firstDate, notes, categoryId } = req.body
    if (!personId || !type || !description || !amount) return badRequest(res, 'Campos obrigatórios faltando.')
    if (!['THEY_OWE_ME', 'I_OWE_THEM'].includes(type)) return badRequest(res, 'Tipo inválido.')
    const amountNum = parseFloat(amount)
    if (!Number.isFinite(amountNum) || amountNum <= 0) return badRequest(res, 'Valor deve ser um número positivo.')
    const rawDay = parseInt(dayOfMonth)
    if (!Number.isFinite(rawDay) || rawDay < 1) return badRequest(res, 'Dia do mês inválido.')
    const parsedDay = Math.min(rawDay, 28)

    // Verify person belongs to user
    const person = await db.person.findFirst({ where: { id: personId, userId: uid } })
    if (!person) return badRequest(res, 'Pessoa não encontrada.')

    const now        = new Date()
    const yearMonth  = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

    // Determine if we should create the first entry immediately.
    // If firstDate is provided and is today or earlier this month, generate the entry now.
    const firstDateObj   = firstDate ? new Date(firstDate) : null
    const isThisMonth    = firstDateObj && firstDateObj.getFullYear() === now.getFullYear() && firstDateObj.getMonth() === now.getMonth()
    const isInPast       = firstDateObj && firstDateObj <= now
    const shouldCreateFirst = isThisMonth && isInPast && categoryId

    const item = await db.personEntryRecurring.create({
      data: {
        personId,
        userId:     uid,
        type,
        description,
        amount:     amountNum,
        dayOfMonth: parsedDay,
        notes:      notes || null,
        categoryId: categoryId || null,
        // Mark this month as processed if we're creating the first entry now
        lastMonth:  shouldCreateFirst ? yearMonth : null,
      },
      include: { person: { select: { id: true, name: true, color: true } }, category: { select: { id: true, name: true, icon: true, color: true } } },
    })

    // Create the first PersonEntry immediately if firstDate is today or already passed
    if (shouldCreateFirst && firstDateObj) {
      await db.personEntry.create({
        data: {
          personId,
          userId:      uid,
          type,
          description,
          amount:      amountNum,
          date:        firstDateObj,
          categoryId:  categoryId || null,
          notes:       notes || null,
        },
      })
    }

    return created(res, item)
  }

  return res.status(405).end()
})
