import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, noContent, notFound } from '@/lib/respond'

export default withAuth(async (req, res, session) => {
  const id  = req.query.id as string
  const uid = session.userId

  const item = await db.personEntryRecurring.findFirst({ where: { id, userId: uid } })
  if (!item) return notFound(res)

  // PATCH — pause/resume or update
  if (req.method === 'PATCH') {
    const updated = await db.personEntryRecurring.update({
      where: { id },
      data:  { isActive: req.body.isActive ?? item.isActive },
    })
    return ok(res, updated)
  }

  // DELETE — stop permanently
  if (req.method === 'DELETE') {
    await db.personEntryRecurring.delete({ where: { id } })
    return noContent(res)
  }

  return res.status(405).end()
})
