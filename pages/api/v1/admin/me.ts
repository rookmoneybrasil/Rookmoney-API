import { withBackofficeAuth, getBackofficeAdmin } from '@/lib/middleware'
import { ok } from '@/lib/respond'

// Returns the logged-in backoffice admin's identity (the cookie is httpOnly so
// the frontend can't decode it) — used to gate UI and show who's logged in.
export default withBackofficeAuth(async (req, res) => {
  const admin = getBackofficeAdmin(req)
  return ok(res, { email: admin.email, role: admin.role })
}, ['GET'])
