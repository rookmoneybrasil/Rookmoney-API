import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, noContent, notFound } from '@/lib/respond'

export default withAuth(async (req, res, session) => {
  const id    = req.query.id as string
  const entry = await db.personEntry.findFirst({ where: { id, userId: session.userId } })
  if (!entry) return notFound(res)

  // POST?action=settle or POST?action=unsettle
  if (req.method === 'POST') {
    const action   = req.query.action as string
    const isSettle = action === 'settle'
    const updated  = await db.personEntry.update({
      where: { id },
      data:  { isSettled: isSettle, settledAt: isSettle ? new Date() : null },
    })
    return ok(res, updated)
  }

  if (req.method === 'DELETE') {
    await db.personEntry.deleteMany({ where: { id, userId: session.userId } })
    return noContent(res)
  }

  return res.status(405).end()
})
