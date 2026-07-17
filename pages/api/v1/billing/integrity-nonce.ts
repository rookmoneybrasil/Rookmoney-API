import { withAuth } from '@/lib/middleware'
import { ok } from '@/lib/respond'
import { issueNonce } from '@/lib/play-integrity'

// Issues a short-lived, user-bound nonce for the Play Integrity request. The
// mobile app fetches this right before requesting the integrity token, feeds it
// to the Play Integrity API, and Google echoes it back inside the decoded token
// so the server can confirm the attestation is fresh and belongs to this user.
export default withAuth(async (req, res, session) => {
  if (req.method !== 'GET') return res.status(405).end()
  return ok(res, { nonce: issueNonce(session.userId) })
}, ['GET'])
