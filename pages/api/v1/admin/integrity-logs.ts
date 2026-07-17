import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'

// Play Integrity attempts are recorded as AdminLog rows (action: 'integrity_check')
// — no dedicated model. `details` encodes the outcome, written by runIntegrityGate's
// caller: "[precheck ]<PASS|FAIL|ERROR|BLOCK> — <summary>".
function parseDetails(details: string): { stage: 'precheck' | 'verify'; status: string; summary: string } {
  let stage: 'precheck' | 'verify' = 'verify'
  let d = details
  if (d.startsWith('precheck ')) {
    stage = 'precheck'
    d = d.slice('precheck '.length)
  }
  const status = d.match(/^(PASS|FAIL|ERROR|BLOCK)/)?.[1] ?? 'UNKNOWN'
  const summary = d.replace(/^(PASS|FAIL|ERROR|BLOCK)\s*—?\s*/, '')
  return { stage, status, summary }
}

export default withBackofficeAuth(async (req, res) => {
  const { page = '1', pageSize = '40', status = '' } = req.query as Record<string, string>
  const skip = (parseInt(page) - 1) * parseInt(pageSize)

  const base = { action: 'integrity_check' as const }
  const where: Record<string, unknown> = { ...base }
  // Filter by outcome via a substring match on the encoded details.
  if (status) where.details = { contains: status }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const recent = { ...base, createdAt: { gte: sevenDaysAgo } }

  const [items, total, total7d, pass7d, fail7d, block7d, error7d] = await Promise.all([
    db.adminLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: parseInt(pageSize) }),
    db.adminLog.count({ where }),
    db.adminLog.count({ where: recent }),
    db.adminLog.count({ where: { ...recent, details: { contains: 'PASS' } } }),
    db.adminLog.count({ where: { ...recent, details: { contains: 'FAIL' } } }),
    db.adminLog.count({ where: { ...recent, details: { contains: 'BLOCK' } } }),
    db.adminLog.count({ where: { ...recent, details: { contains: 'ERROR' } } }),
  ])

  // AdminLog has no FK to the user (targetId is a bare id) — resolve names in one query.
  const ids = [...new Set(items.map(i => i.targetId))]
  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, email: true },
  })
  const userMap = new Map(users.map(u => [u.id, u]))

  const denied7d = fail7d + block7d
  return ok(res, {
    summary: {
      total7d,
      pass7d,
      denied7d,
      error7d,
      denyRate7d: total7d > 0 ? Math.round((denied7d / total7d) * 1000) / 10 : 0,
    },
    items: items.map(l => {
      const p = parseDetails(l.details)
      return {
        id: l.id,
        stage: p.stage,
        status: p.status,
        summary: p.summary,
        createdAt: l.createdAt,
        user: userMap.get(l.targetId) ?? null,
      }
    }),
    total,
    page: parseInt(page),
    totalPages: Math.ceil(total / parseInt(pageSize)),
  })
}, ['GET'])
