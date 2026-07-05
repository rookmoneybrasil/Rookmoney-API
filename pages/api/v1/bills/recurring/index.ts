import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, created, badRequest } from '@/lib/respond'
import { format, addMonths } from 'date-fns'
import { checkAchievements } from '@/lib/achievement-checker'
import { Prisma } from '@/generated/prisma/client'

// Generate bill instances from a template for the current month
async function generateForTemplate(
  userId: string,
  template: { id: string; name: string; amount: unknown; dayOfMonth: number; categoryId: string | null; notes: string | null },
  yearMonth: string,
) {
  const [y, m] = yearMonth.split('-').map(Number)
  const day    = Math.min(template.dayOfMonth, new Date(y, m, 0).getDate()) // clamp to month length
  const dueDate = new Date(Date.UTC(y, m - 1, day, 12, 0, 0))

  // Check if already generated — use Date.UTC(y, m, 0) for last day of month
  // (day 0 of next month = last day of current month, avoids 31-day overflow)
  const existing = await db.bill.findFirst({
    where: { userId, recurringBillId: template.id, dueDate: { gte: new Date(Date.UTC(y, m - 1, 1)), lte: new Date(Date.UTC(y, m, 0, 23, 59, 59)) } },
  })
  if (existing) return existing

  let bill
  try {
    bill = await db.bill.create({
      data: {
        name:           template.name,
        amount:         template.amount as number,
        dueDate,
        isRecurring:    false,
        userId,
        categoryId:     template.categoryId ?? null,
        notes:          template.notes ?? null,
        recurringBillId: template.id,
        recurringMonth: yearMonth,
      },
    })
  } catch (err) {
    // Unique on (recurringBillId, recurringMonth) — the shared generator (running
    // in a concurrent GET/dashboard for the same user) beat us to it. Use theirs.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await db.bill.findFirst({ where: { userId, recurringBillId: template.id, recurringMonth: yearMonth } })
      if (winner) return winner
    }
    throw err
  }

  await db.recurringBill.update({ where: { id: template.id }, data: { lastAutoMonth: yearMonth } })
  return bill
}

export default withAuth(async (req, res, session) => {
  const uid = session.userId

  // ── GET — list templates ──────────────────────────────────────────
  if (req.method === 'GET') {
    const templates = await db.recurringBill.findMany({
      where:   { userId: uid },
      orderBy: { name: 'asc' },
      include: { category: { select: { id: true, name: true, icon: true, color: true } } },
    })
    return ok(res, templates)
  }

  // ── POST — create template (optionally generate this month) ────────
  if (req.method === 'POST') {
    const { name, amount, dayOfMonth, categoryId, notes, generateNow, firstDate } = req.body
    if (!name || !amount || !dayOfMonth) return badRequest(res, 'Nome, valor e dia do mês são obrigatórios.')
    const parsedAmount = parseFloat(amount)
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) return badRequest(res, 'Valor deve ser um número positivo.')
    const rawDay = parseInt(dayOfMonth)
    if (!Number.isFinite(rawDay) || rawDay < 1) return badRequest(res, 'Dia do mês inválido.')
    const day = Math.min(rawDay, 31)

    const now       = new Date()
    const yearMonth = format(now, 'yyyy-MM')

    // startMonth = the month of the picked "1ª data" (or the current month when
    // it's in the past / omitted). The generator and every KPI/projection skip a
    // template until its startMonth arrives — mirrors PersonEntryRecurring.
    const firstDateObj = firstDate ? new Date(firstDate) : null
    const startMonth = firstDateObj && firstDateObj > now
      ? format(firstDateObj, 'yyyy-MM')
      : yearMonth
    // Generate the first bill immediately only when the picked date is this month
    // and already passed (or the legacy generateNow flag was sent with no date).
    const isThisMonth = firstDateObj && firstDateObj.getFullYear() === now.getFullYear() && firstDateObj.getMonth() === now.getMonth()
    const shouldGenerateNow = (isThisMonth && firstDateObj! <= now) || (!firstDateObj && generateNow)

    const template = await db.recurringBill.create({
      data: {
        name,
        amount:     parsedAmount,
        dayOfMonth: day,
        userId:     uid,
        categoryId: categoryId ?? null,
        notes:      notes ?? null,
        startMonth,
      },
      include: { category: { select: { id: true, name: true, icon: true, color: true } } },
    })

    if (shouldGenerateNow) {
      await generateForTemplate(uid, template, yearMonth)
      const updated = await db.recurringBill.findUnique({ where: { id: template.id }, include: { category: { select: { id: true, name: true, icon: true, color: true } } } })
      checkAchievements(db, uid, 'create-recurring-bill').catch(() => {})
      return created(res, updated)
    }

    checkAchievements(db, uid, 'create-recurring-bill').catch(() => {})
    return created(res, template)
  }

  // ── POST ?action=generate-month — manually trigger this month ──────
  if (req.method === 'POST' && req.query.action === 'generate-month') {
    const yearMonth = format(new Date(), 'yyyy-MM')
    const templates = await db.recurringBill.findMany({ where: { userId: uid, isActive: true } })
    const generated: unknown[] = []
    for (const t of templates) {
      if (t.lastAutoMonth === yearMonth) continue
      const bill = await generateForTemplate(uid, t, yearMonth)
      generated.push(bill)
    }
    return ok(res, { generated: generated.length })
  }

  return res.status(405).end()
})
