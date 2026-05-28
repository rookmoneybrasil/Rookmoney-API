import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { noContent, notFound } from '@/lib/respond'

export default withAuth(async (req, res, session) => {
  if (req.method !== 'DELETE') return res.status(405).end()

  const groupId = req.query.groupId as string
  // Verify ownership
  const count = await db.bill.count({ where: { installmentGroupId: groupId, userId: session.userId } })
  if (count === 0) return notFound(res)

  await db.bill.deleteMany({ where: { installmentGroupId: groupId, userId: session.userId } })
  return noContent(res)
})
