import type { NextApiRequest, NextApiResponse } from 'next'
import { db } from '@/lib/db'
import { format } from 'date-fns'

async function migrateOldRecurring(userId: string) {
  const now = new Date()
  const entries = await db.personEntry.findMany({
    where: { userId, isSettled: false, installmentGroupId: { not: null }, installmentTotal: { gte: 24 } },
    orderBy: { installmentCurrent: 'asc' },
  })
  const groupMap = new Map<string, typeof entries>()
  for (const e of entries) {
    const arr = groupMap.get(e.installmentGroupId!) ?? []
    arr.push(e)
    groupMap.set(e.installmentGroupId!, arr)
  }
  for (const [groupId, group] of groupMap.entries()) {
    const hasSettled = await db.personEntry.count({ where: { installmentGroupId: groupId, isSettled: true } })
    if (hasSettled > 0) continue
    const first = group[0]
    const existing = await db.personEntryRecurring.findFirst({
      where: { userId, personId: first.personId, description: first.description, isActive: true },
    })
    if (!existing) {
      await db.personEntryRecurring.create({
        data: {
          userId, personId: first.personId, type: first.type,
          description: first.description, amount: first.amount,
          dayOfMonth: Math.min(new Date(first.date).getDate(), 28),
          notes: first.notes, categoryId: first.categoryId,
          lastMonth: format(now, 'yyyy-MM'),
        },
      })
    }
    const upcoming = group.filter(e => new Date(e.date) >= now).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    // Delete ALL entries in the group — cron will create next one from template
    await db.personEntry.deleteMany({ where: { installmentGroupId: groupId, userId } })
  }
}

async function processAutoIncome(userId: string) {
  const now       = new Date()
  const today     = now.getDate()
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

  const sources = await db.incomeSource.findMany({ where: { userId, isRecurring: true } })

  for (const src of sources) {
    if (!src.categoryId || !src.dayOfMonth) continue
    if (src.lastAutoPayMonth === yearMonth) continue
    if (today < src.dayOfMonth) continue
    await db.$transaction([
      db.transaction.create({ data: { amount: src.amount, type: 'INCOME', description: src.name, date: new Date(now.getFullYear(), now.getMonth(), src.dayOfMonth), userId, categoryId: src.categoryId } }),
      db.incomeSource.update({ where: { id: src.id }, data: { lastAutoPayMonth: yearMonth } }),
    ])
  }
}

async function processPersonEntryRecurring(userId: string) {
  const now       = new Date()
  const today     = now.getDate()
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

  const items = await db.personEntryRecurring.findMany({ where: { userId, isActive: true } })

  for (const item of items) {
    if (item.lastMonth === yearMonth) continue
    if (today < item.dayOfMonth) continue

    const entryDate = new Date(now.getFullYear(), now.getMonth(), item.dayOfMonth)

    await db.$transaction([
      db.personEntry.create({
        data: {
          personId:   item.personId,
          userId,
          type:       item.type,
          description: item.description,
          amount:     item.amount,
          date:       entryDate,
          notes:      item.notes,
          categoryId: item.categoryId,
        },
      }),
      db.personEntryRecurring.update({ where: { id: item.id }, data: { lastMonth: yearMonth } }),
    ])
  }
}

async function processAutoRecurring(userId: string) {
  const now       = new Date()
  const today     = now.getDate()
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

  const items = await db.recurringTransaction.findMany({ where: { userId, isActive: true, frequency: 'MONTHLY' } })

  for (const item of items) {
    if (!item.categoryId) continue
    if (item.lastAutoMonth === yearMonth) continue
    if (item.dayOfMonth && today < item.dayOfMonth) continue
    await db.$transaction([
      db.transaction.create({ data: { amount: item.amount, type: item.type, description: item.name, date: new Date(now.getFullYear(), now.getMonth(), item.dayOfMonth ?? 1), userId, categoryId: item.categoryId } }),
      db.recurringTransaction.update({ where: { id: item.id }, data: { lastAutoMonth: yearMonth } }),
    ])
  }
}


async function processRecurringBills(userId: string) {
  const now       = new Date()
  const today     = now.getDate()
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const y = now.getFullYear()
  const m = now.getMonth() // 0-based

  const templates = await db.recurringBill.findMany({ where: { userId, isActive: true } })

  for (const t of templates) {
    if (t.lastAutoMonth === yearMonth) continue
    // No day-of-month gate — bills are generated at month start so users see them immediately.

    const day     = Math.min(t.dayOfMonth, new Date(y, m + 1, 0).getDate())
    const dueDate = new Date(Date.UTC(y, m, day, 12, 0, 0))

    const monthStart = new Date(Date.UTC(y, m, 1))
    const monthEnd   = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59))

    const exists = await db.bill.findFirst({
      where: { userId, recurringBillId: t.id, dueDate: { gte: monthStart, lte: monthEnd } },
    })
    if (exists) {
      await db.recurringBill.update({ where: { id: t.id }, data: { lastAutoMonth: yearMonth } })
      continue
    }

    await db.$transaction([
      db.bill.create({
        data: { name: t.name, amount: t.amount, dueDate, isRecurring: false, userId, categoryId: t.categoryId ?? null, notes: t.notes ?? null, recurringBillId: t.id },
      }),
      db.recurringBill.update({ where: { id: t.id }, data: { lastAutoMonth: yearMonth } }),
    ])
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end()

  const secret = process.env.CRON_SECRET
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const users = await db.user.findMany({ select: { id: true } })

  let processed = 0
  const errors: string[] = []

  for (const user of users) {
    try {
      await migrateOldRecurring(user.id)
      await processAutoIncome(user.id)
      await processAutoRecurring(user.id)
      await processPersonEntryRecurring(user.id)
      await processRecurringBills(user.id)
      processed++
    } catch (err) {
      errors.push(`${user.id}: ${String(err)}`)
    }
  }

  return res.status(200).json({ ok: true, processed, errors })
}
