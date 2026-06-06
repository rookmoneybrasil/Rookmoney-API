import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'
import { fetchBoletos } from '@/lib/pluggy'

export default withAuth(async (_req, res, session) => {
  const items = await db.pluggyItem.findMany({
    where:  { userId: session.userId },
    select: { id: true, itemId: true, connectorName: true },
  })

  if (items.length === 0) return ok(res, { boletos: [], items: [] })

  const results = await Promise.allSettled(
    items.map(item => fetchBoletos(item.itemId))
  )

  const boletos = results.flatMap((r, i) =>
    r.status === 'fulfilled'
      ? r.value.map(b => ({ ...b, connectorName: items[i].connectorName }))
      : []
  )

  // Update lastSyncAt for items that synced successfully
  const syncedIds = results
    .map((r, i) => r.status === 'fulfilled' ? items[i].id : null)
    .filter(Boolean) as string[]

  if (syncedIds.length) {
    await db.pluggyItem.updateMany({
      where: { id: { in: syncedIds } },
      data:  { lastSyncAt: new Date() },
    })
  }

  return ok(res, {
    boletos,
    items: items.map((item, i) => ({
      id:            item.id,
      connectorName: item.connectorName,
      ok:            results[i].status === 'fulfilled',
    })),
  })
}, ['GET'])
