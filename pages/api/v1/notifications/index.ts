import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'
import { format, addDays, startOfMonth, endOfMonth } from 'date-fns'

export default withAuth(async (req, res, session) => {
  if (req.method !== 'GET') return res.status(405).end()

  const uid  = session.userId
  const now  = new Date()
  const in3  = addDays(now, 3)
  const in7  = addDays(now, 7)
  const month = format(now, 'yyyy-MM')

  const [bills, goals, budgets, txs] = await Promise.all([
    db.bill.findMany({ where: { userId: uid, isPaid: false, dueDate: { gte: now, lte: in3 } }, orderBy: { dueDate: 'asc' } }),
    db.goal.findMany({ where: { userId: uid, isCompleted: false, deadline: { gte: now, lte: in7 } }, orderBy: { deadline: 'asc' } }),
    db.budget.findMany({ where: { userId: uid, month }, include: { category: true } }),
    db.transaction.findMany({ where: { userId: uid, type: 'EXPENSE', date: { gte: startOfMonth(now), lte: endOfMonth(now) } } }),
  ])

  const notifications: Array<{ id: string; type: 'bill' | 'goal' | 'budget'; title: string; message: string; href: string; urgency: 'high' | 'medium' }> = []

  for (const b of bills) {
    const diff = Math.ceil((new Date(b.dueDate).getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    const when = diff <= 0 ? 'vence hoje' : diff === 1 ? 'vence amanhã' : `vence em ${diff} dias`
    notifications.push({ id: `bill-${b.id}`, type: 'bill', title: b.name, message: `${when} · R$ ${Number(b.amount).toFixed(2)}`, href: '/bills', urgency: diff <= 1 ? 'high' : 'medium' })
  }

  for (const g of goals) {
    if (!g.deadline) continue
    const diff = Math.ceil((new Date(g.deadline).getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    const pct  = g.targetAmount > 0 ? Math.round((Number(g.currentAmount) / Number(g.targetAmount)) * 100) : 0
    notifications.push({ id: `goal-${g.id}`, type: 'goal', title: g.name, message: `${pct}% concluída · prazo em ${diff} dias`, href: '/goals', urgency: pct < 50 ? 'high' : 'medium' })
  }

  for (const bgt of budgets) {
    const spent = txs.filter(t => t.categoryId === bgt.categoryId).reduce((s, t) => s + Number(t.amount), 0)
    const pct   = Number(bgt.amount) > 0 ? Math.round((spent / Number(bgt.amount)) * 100) : 0
    if (pct >= 80) {
      notifications.push({ id: `budget-${bgt.id}`, type: 'budget', title: bgt.category.name, message: `${pct}% do orçamento utilizado`, href: '/budget', urgency: pct >= 100 ? 'high' : 'medium' })
    }
  }

  return ok(res, notifications)
})
