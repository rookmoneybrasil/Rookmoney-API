import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, planRequired } from '@/lib/respond'
import { getLimits } from '@/lib/plans'

export default withAuth(async (req, res, session) => {
  if (req.method !== 'GET') return res.status(405).end()
  const limits = getLimits(session.plan ?? 'FREE')
  if (!limits.import) return planRequired(res, 'Exportar dados')

  const uid = session.userId

  const [transactions, categories, goals, bills, budgets, incomeSources, recurring, people, entries] = await Promise.all([
    db.transaction.findMany({ where: { userId: uid }, include: { category: { select: { name: true, icon: true } } }, orderBy: { date: 'desc' } }),
    db.category.findMany({ where: { userId: uid }, orderBy: { name: 'asc' } }),
    db.goal.findMany({ where: { userId: uid }, include: { contributions: { orderBy: { createdAt: 'desc' } } }, orderBy: { createdAt: 'desc' } }),
    db.bill.findMany({ where: { userId: uid }, include: { category: { select: { name: true, icon: true } } }, orderBy: { dueDate: 'asc' } }),
    db.budget.findMany({ where: { userId: uid }, include: { category: { select: { name: true } } }, orderBy: { month: 'desc' } }),
    db.incomeSource.findMany({ where: { userId: uid }, orderBy: { name: 'asc' } }),
    db.recurringTransaction.findMany({ where: { userId: uid }, include: { category: { select: { name: true, icon: true } } }, orderBy: { name: 'asc' } }),
    db.person.findMany({ where: { userId: uid }, orderBy: { name: 'asc' } }),
    db.personEntry.findMany({ where: { userId: uid }, include: { person: { select: { name: true } } }, orderBy: { date: 'desc' } }),
  ])

  return ok(res, {
    exportedAt: new Date().toISOString(),
    version:    '1.0',
    user:       { name: session.name, email: session.email },
    data: {
      transactions:          transactions.map(t => ({ id: t.id, type: t.type, amount: Number(t.amount), description: t.description, date: t.date, category: t.category.name })),
      categories:            categories.map(c => ({ id: c.id, name: c.name, icon: c.icon, color: c.color })),
      goals:                 goals.map(g => ({ id: g.id, name: g.name, targetAmount: Number(g.targetAmount), currentAmount: Number(g.currentAmount), deadline: g.deadline, isCompleted: g.isCompleted, contributions: g.contributions.map(c => ({ amount: Number(c.amount), note: c.note, createdAt: c.createdAt })) })),
      bills:                 bills.map(b => ({ id: b.id, name: b.name, amount: Number(b.amount), dueDate: b.dueDate, isPaid: b.isPaid, isRecurring: b.isRecurring, installmentCurrent: b.installmentCurrent, installmentTotal: b.installmentTotal, category: b.category?.name ?? null })),
      budgets:               budgets.map(b => ({ id: b.id, month: b.month, amount: Number(b.amount), category: b.category.name })),
      incomeSources:         incomeSources.map(s => ({ id: s.id, name: s.name, type: s.type, amount: Number(s.amount), isRecurring: s.isRecurring })),
      recurringTransactions: recurring.map(r => ({ id: r.id, name: r.name, type: r.type, amount: Number(r.amount), frequency: r.frequency, isActive: r.isActive, category: r.category.name })),
      people:                people.map(p => ({ id: p.id, name: p.name, notes: p.notes })),
      personEntries:         entries.map(e => ({ id: e.id, type: e.type, description: e.description, amount: Number(e.amount), date: e.date, isSettled: e.isSettled, person: e.person.name })),
    },
  })
})
