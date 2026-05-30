import type { NextApiRequest, NextApiResponse } from 'next'
import { db } from '@/lib/db'

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
      await processAutoIncome(user.id)
      await processAutoRecurring(user.id)
      await processPersonEntryRecurring(user.id)
      processed++
    } catch (err) {
      errors.push(`${user.id}: ${String(err)}`)
    }
  }

  return res.status(200).json({ ok: true, processed, errors })
}
