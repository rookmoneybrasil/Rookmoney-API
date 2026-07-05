import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'

// Crons we expect to see runs for, with the max age (hours) before "atrasado".
const KNOWN_CRONS: { name: string; expectedEveryHours: number }[] = [
  { name: 'daily',         expectedEveryHours: 26 }, // roda 8h/dia — 24h + folga
  { name: 'blog-generate', expectedEveryHours: 26 }, // disparado pelo daily
]

export default withBackofficeAuth(async (req, res) => {
  const { page = '1', pageSize = '30', name = '' } = req.query as Record<string, string>
  const skip = (parseInt(page) - 1) * parseInt(pageSize)

  const where: Record<string, unknown> = {}
  if (name) where.name = name

  // Latest run per known cron (for the status cards)
  const latest = await Promise.all(
    KNOWN_CRONS.map(async (c) => {
      const run = await db.cronRun.findFirst({
        where: { name: c.name },
        orderBy: { startedAt: 'desc' },
      })
      return { name: c.name, expectedEveryHours: c.expectedEveryHours, lastRun: run }
    }),
  )

  const [items, total] = await Promise.all([
    db.cronRun.findMany({
      where, orderBy: { startedAt: 'desc' },
      skip, take: parseInt(pageSize),
    }),
    db.cronRun.count({ where }),
  ])

  return ok(res, {
    latest,
    items,
    total,
    page: parseInt(page),
    totalPages: Math.ceil(total / parseInt(pageSize)),
  })
}, ['GET'])
