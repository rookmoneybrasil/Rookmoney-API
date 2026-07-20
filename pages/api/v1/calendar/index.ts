import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'
import { startOfMonth, endOfMonth, format } from 'date-fns'

export type CalendarEvent = {
  id:       string
  day:      number   // 1-31
  type:     'bill' | 'income'
  label:    string
  amount:   number
  status:   'pending' | 'paid' | 'overdue' | 'expected' | 'received'
  href:     string
  color:    string
}

export default withAuth(async (req, res, session) => {
  if (req.method !== 'GET') return res.status(405).end()

  const now      = new Date()
  const monthStr = (req.query.month as string) ?? format(now, 'yyyy-MM')
  const [y, m]   = monthStr.split('-').map(Number)
  const monthDate = new Date(y, m - 1, 1)
  const start     = startOfMonth(monthDate)
  const end       = endOfMonth(monthDate)
  const maxDay    = end.getDate()
  const uid       = session.userId

  const [bills, incomeSources, recurringBills] = await Promise.all([
    db.bill.findMany({
      where:   { userId: uid, dueDate: { gte: start, lte: end } },
      select:  { id: true, name: true, amount: true, dueDate: true, isPaid: true, recurringBillId: true },
      orderBy: { dueDate: 'asc' },
    }),

    // Bug 3 fix: include lastAutoPayMonth to detect already-received income
    db.incomeSource.findMany({
      where:  { userId: uid, isRecurring: true },
      select: { id: true, name: true, amount: true, dayOfMonth: true, lastAutoPayMonth: true, startDate: true },
    }),

    // Bug 1 fix: fetch RecurringBill templates for future months
    db.recurringBill.findMany({
      where:  { userId: uid, isActive: true },
      select: { id: true, name: true, amount: true, dayOfMonth: true },
    }),
  ])

  const events: CalendarEvent[] = []

  // ── Bills (generated instances) ──────────────────────────────────────────────
  const coveredTemplateIds = new Set<string>()
  for (const b of bills) {
    const day = new Date(b.dueDate).getDate()
    const isOverdue = !b.isPaid && new Date(b.dueDate) < now
    if (b.recurringBillId) coveredTemplateIds.add(b.recurringBillId)
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

  // Bug 1 fix: add RecurringBill templates NOT yet generated for this month
  for (const t of recurringBills) {
    if (coveredTemplateIds.has(t.id)) continue  // already covered by a generated bill
    const day = Math.min(t.dayOfMonth, maxDay)
    events.push({
      id:     `recbill-${t.id}`,
      day,
      type:   'bill',
      label:  t.name,
      amount: Number(t.amount),
      status: 'expected',   // not yet generated — shown as preview
      href:   '/bills',
      color:  'warning',
    })
  }

  // ── Income sources ────────────────────────────────────────────────────────────
  for (const s of incomeSources) {
    // Skip sources that haven't started yet
    if (s.startDate && s.startDate > monthDate) continue
    const day = Math.min(s.dayOfMonth ?? 1, maxDay)
    // Bug 3 fix: show as 'received' if already processed this month
    const alreadyReceived = s.lastAutoPayMonth === monthStr
    events.push({
      id:     `income-${s.id}`,
      day,
      type:   'income',
      label:  s.name,
      amount: Number(s.amount),
      status: alreadyReceived ? 'received' : 'expected',
      href:   '/income',
      color:  alreadyReceived ? 'success' : 'success',
    })
  }

  // Group by day
  const byDay: Record<number, CalendarEvent[]> = {}
  for (const ev of events) {
    if (!byDay[ev.day]) byDay[ev.day] = []
    byDay[ev.day].push(ev)
  }

  return ok(res, {
    month:        monthStr,
    daysInMonth:  maxDay,
    firstWeekday: startOfMonth(monthDate).getDay(),
    events,
    byDay,
  })
})
