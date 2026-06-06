import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, created, badRequest, serverError } from '@/lib/respond'
import { fetchItem } from '@/lib/pluggy'

export default withAuth(async (req, res, session) => {
  if (req.method === 'GET') {
    const items = await db.pluggyItem.findMany({
      where:   { userId: session.userId },
      orderBy: { createdAt: 'desc' },
      select:  { id: true, itemId: true, connectorId: true, connectorName: true, status: true, lastSyncAt: true, createdAt: true },
    })
    return ok(res, items)
  }

  if (req.method === 'POST') {
    const { itemId } = req.body as { itemId?: string }
    if (!itemId?.trim()) return badRequest(res, 'itemId é obrigatório.')

    let pluggyItem
    try {
      pluggyItem = await fetchItem(itemId)
    } catch (err) {
      return serverError(res, err)
    }

    const saved = await db.pluggyItem.upsert({
      where:  { itemId },
      update: {
        userId:        session.userId,
        connectorId:   pluggyItem.connector.id,
        connectorName: pluggyItem.connector.name,
        status:        pluggyItem.status,
        updatedAt:     new Date(),
      },
      create: {
        userId:        session.userId,
        itemId,
        connectorId:   pluggyItem.connector.id,
        connectorName: pluggyItem.connector.name,
        status:        pluggyItem.status,
      },
    })

    return created(res, saved)
  }

  return res.status(405).end()
})
