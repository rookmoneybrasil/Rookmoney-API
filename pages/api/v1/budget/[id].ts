import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { noContent, notFound } from '@/lib/respond'

export default withAuth(async (req, res, session) => {
  if (req.method !== 'DELETE') return res.status(405).end()

  const id = req.query.id as string
  const budget = await db.budget.findFirst({ where: { id, userId: session.userId } })
  if (!budget) return notFound(res)

  await db.budget.delete({ where: { id } })
  return noContent(res)
})
