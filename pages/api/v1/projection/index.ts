import { withAuth } from '@/lib/middleware'
import { ok, planRequired } from '@/lib/respond'
import { getLimits } from '@/lib/plans'
import { getProjection } from '@/lib/projection'

export default withAuth(async (req, res, session) => {
  if (req.method !== 'GET') return res.status(405).end()
  const limits = getLimits(session.plan ?? 'FREE')
  if (!limits.projection) return planRequired(res, 'Projeção financeira')

  const months = Math.min(Number(req.query.months ?? 6), 12)
  const result = await getProjection(session.userId, months)
  return ok(res, result)
})
