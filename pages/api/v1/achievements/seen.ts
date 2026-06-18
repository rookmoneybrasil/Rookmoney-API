import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'

export default withAuth(async (req, res, session) => {
  if (req.method !== 'POST') return res.status(405).end()

  await db.userAchievement.updateMany({
    where: { userId: session.userId, seen: false },
    data:  { seen: true },
  })

  return ok(res, { marked: true })
}, ['POST'])
