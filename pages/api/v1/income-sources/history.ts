import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'
import { subMonths, startOfMonth } from 'date-fns'

export default withAuth(async (req, res, session) => {
  if (req.method !== 'GET') return res.status(405).end()

  const uid = session.userId
  const since = startOfMonth(subMonths(new Date(), 11)) // last 12 months

  // Get all source names (recurring + eventual)
  const sources = await db.incomeSource.findMany({
    where:  { userId: uid },
    select: { name: true },
  })
  const names = sources.map((s) => s.name)
  if (!names.length) return ok(res, {})

  // Fetch INCOME transactions matching those names in the last 12 months
  const txs = await db.transaction.findMany({
    where: {
      userId:      uid,
      type:        'INCOME',
      description: { in: names },
      date:        { gte: since },
    },
    orderBy: { date: 'desc' },
    include: { category: { select: { id: true, name: true, icon: true, color: true } } },
  })

  // Group by source name
  const grouped: Record<string, { id: string; amount: number; date: string; category: { id: string; name: string; icon: string; color: string } | null }[]> = {}
  for (const tx of txs) {
    const key = tx.description!
    if (!grouped[key]) grouped[key] = []
    grouped[key].push({
      id:       tx.id,
      amount:   Number(tx.amount),
      date:     tx.date.toISOString(),
      category: tx.category,
    })
  }

  return ok(res, grouped)
})
