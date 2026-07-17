import { withAuth } from '@/lib/middleware'
import { ok } from '@/lib/respond'
import { db } from '@/lib/db'
import { runIntegrityGate, INTEGRITY_DENIED } from '@/lib/play-integrity'

// Pre-purchase Play Integrity check (Android). The app calls this BEFORE opening
// the Google Play purchase sheet so a compromised device is stopped without ever
// being charged (avoids the charge→auto-refund churn of blocking post-purchase).
// Shares the exact same decision as the verify endpoint via runIntegrityGate.
export default withAuth(async (req, res, session) => {
  if (req.method !== 'POST') return res.status(405).end()

  const { integrityToken } = req.body ?? {}

  const gate = await runIntegrityGate(integrityToken, session.userId)
  if (gate.log) {
    db.adminLog
      .create({ data: { action: 'integrity_check', targetId: session.userId, details: `precheck ${gate.log}` } })
      .catch(() => {})
  }
  if (!gate.allow) return res.status(403).json({ ok: false, ...INTEGRITY_DENIED })

  return ok(res, { allowed: true })
}, ['POST'])
