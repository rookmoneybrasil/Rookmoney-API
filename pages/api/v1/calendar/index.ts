import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'
import { startOfMonth, endOfMonth, format } from 'date-fns'

export type CalendarEvent = {
  id:       string
  day:      number   // 1-31
  type:     'bill' | 'income' | 'recurring'
  label:    string
  amount:   number
  status:   'pending' | 'paid' | 'overdue' | 'expected'
  href:     string
  color:    string   // tailwind color key
}

export default withAuth(async (req, res, session) => {
  if (req.method !== 'GET') return res.status(405).end()

  const now       = new Date()
  const monthStr  = (req.query.month as string) ?? format(now, 'yyyy-MM')
  const monthDate = new Date(monthStr + '-01')
  const start     = startOfMonth(monthDate)
  const end       = endOfMonth(monthDate)
  const uid       = session.userId

  const [bills, incomeSources, recurring] = await Promise.all([
    // Bills with dueDate in this month
    db.bill.findMany({
      where:   { userId: uid, dueDate: { gte: start, lte: end } },
      select:  { id: true, name: true, amount: true, dueDate: true, isPaid: true },
      orderBy: { dueDate: 'asc' },
    }),

    // Recurring income sources with dayOfMonth
    db.incomeSource.findMany({
      where:  { userId: uid, isRecurring: true, dayOfMonth: { not: null } },
      select: { id: true, name: true, amount: true, dayOfMonth: true },
    }),

    // Recurring transactions active in this month
    db.recurringTransaction.findMany({
      where:  { userId: uid, isActive: true, frequency: 'MONTHLY', dayOfMonth: { not: null } },
      select: { id: true, name: true, amount: true, type: true, dayOfMonth: true },
    }),
  ])

  const events: CalendarEvent[] = []

  // Bills
  for (const b of bills) {
    const day = new Date(b.dueDate).getDate()
    const isOverdue = !b.isPaid && new Date(b.dueDate) < now
    events.push({
      id:     b.id,
      day,
      type:   'bill',
      label:  b.name,
      amount: Number(b.amount),
      status: b.isPaid ? 'paid' : isOverdue ? 'overdue' : 'pending',
      href:   '/bills',
      color:  b.isPaid ? 'success' : isOverdue ? 'danger' : 'warning',
    })
  }

  // Income sources (recurring)
  for (const s of incomeSources) {
    if (!s.dayOfMonth) continue
    const day = s.dayOfMonth
    if (day < 1 || day > endOfMonth(monthDate).getDate()) continue
    events.push({
      id:     `income-${s.id}`,
      day,
      type:   'income',
      label:  s.name,
      amount: Number(s.amount),
      status: 'expected',
      href:   '/income',
      color:  'success',
    })
  }

  // Recurring transactions
  for (const r of recurring) {
    if (!r.dayOfMonth) continue
    const day = r.dayOfMonth
    if (day < 1 || day > endOfMonth(monthDate).getDate()) continue
    events.push({
      id:     `rec-${r.id}`,
      day,
      type:   'recurring',
      label:  r.name,
      amount: Number(r.amount),
      status: r.type === 'INCOME' ? 'expected' : 'pending',
      href:   '/recurring',
      color:  r.type === 'INCOME' ? 'success' : 'warning',
    })
  }

  // Group by day
  const byDay: Record<number, CalendarEvent[]> = {}
  for (const ev of events) {
    if (!byDay[ev.day]) byDay[ev.day] = []
    byDay[ev.day].push(ev)
  }

  return ok(res, {
    month:   monthStr,
    daysInMonth: endOfMonth(monthDate).getDate(),
    firstWeekday: startOfMonth(monthDate).getDay(), // 0=Sun
    events,
    byDay,
  })
})
