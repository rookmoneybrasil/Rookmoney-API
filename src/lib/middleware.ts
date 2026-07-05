import type { NextApiRequest, NextApiResponse } from 'next'
import { getSessionFromRequest, type Session } from './auth'
import { unauthorized, serverError, methodNotAllowed, forbidden } from './respond'
import { db } from './db'

type Methods = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

// ─── Backoffice admin identity ────────────────────────────────────────────────

export type AdminRole = 'support' | 'superadmin'
export interface BackofficeAdmin { email: string; role: AdminRole }
export interface BackofficeRequest extends NextApiRequest { admin?: BackofficeAdmin }

// Read the admin identity attached by withBackofficeAuth. Tokens issued before
// the roles feature (and break-glass) resolve to superadmin so nobody is locked
// out mid-session and legacy single-secret access keeps full power.
export function getBackofficeAdmin(req: NextApiRequest): BackofficeAdmin {
  return (req as BackofficeRequest).admin ?? { email: 'legacy', role: 'superadmin' }
}

// Guard for sensitive actions inside a handler. Returns false (and sends 403)
// when the caller isn't a superadmin.
export function requireSuperadmin(req: NextApiRequest, res: NextApiResponse): boolean {
  if (getBackofficeAdmin(req).role !== 'superadmin') {
    forbidden(res, 'Ação restrita a superadmin')
    return false
  }
  return true
}

type AuthHandler = (
  req:     NextApiRequest,
  res:     NextApiResponse,
  session: Session,
) => Promise<unknown> | void

type PublicHandler = (
  req: NextApiRequest,
  res: NextApiResponse,
) => Promise<unknown> | void

// ─── withAuth — wraps route, validates session ────────────────────────────────

export function withAuth(handler: AuthHandler, methods?: Methods[]) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    setCORSHeaders(res, req)
    if (req.method === 'OPTIONS') return res.status(204).end()

    if (methods && !methods.includes(req.method as Methods)) {
      return methodNotAllowed(res)
    }

    try {
      const session = await getSessionFromRequest(req)
      if (!session) return unauthorized(res)
      const user = await db.user.findUnique({ where: { id: session.userId }, select: { plan: true, tokenVersion: true } })
      // Fix 5: reject tokens issued before the current tokenVersion (revocation)
      if (user?.tokenVersion !== undefined && session.tokenVersion !== undefined &&
          session.tokenVersion < user.tokenVersion) {
        return unauthorized(res, 'Sessão expirada. Faça login novamente.')
      }
      // Block mutations from impersonation sessions — read-only mode
      if (session.impersonating && req.method !== 'GET') {
        return res.status(403).json({ ok: false, error: 'Ação bloqueada no modo visualização.', code: 'IMPERSONATING' })
      }

      // Fire-and-forget: only writes if last update was > 1 min ago to avoid per-request DB writes
      db.user.updateMany({
        where: { id: session.userId, OR: [{ lastActiveAt: null }, { lastActiveAt: { lt: new Date(Date.now() - 60_000) } }] },
        data: { lastActiveAt: new Date() },
      }).catch(() => {})
      await handler(req, res, { ...session, plan: user?.plan ?? 'FREE' })
    } catch (err) {
      serverError(res, err)
    }
  }
}

// ─── withAdminAuth — same but checks isAdmin flag ─────────────────────────────

export function withAdminAuth(handler: AuthHandler, methods?: Methods[]) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    setCORSHeaders(res, req)
    if (req.method === 'OPTIONS') return res.status(204).end()

    if (methods && !methods.includes(req.method as Methods)) {
      return methodNotAllowed(res)
    }

    try {
      // Check rook_admin cookie (separate admin session)
      const adminToken = req.cookies['rook_admin']
      if (!adminToken) {
        const { unauthorized: unauth } = await import('./respond')
        return unauth(res, 'Acesso de admin necessário')
      }

      const { verifyToken } = await import('./auth')
      const payload = await verifyToken(adminToken)
      if (!payload) return unauthorized(res, 'Sessão de admin inválida')

      // Also need a user session for user info
      const session = await getSessionFromRequest(req)
      if (!session) return unauthorized(res)

      // Verify isAdmin in DB
      const user = await db.user.findUnique({ where: { id: session.userId }, select: { isAdmin: true } })
      if (!user?.isAdmin) {
        const { forbidden } = await import('./respond')
        return forbidden(res)
      }

      await handler(req, res, session)
    } catch (err) {
      serverError(res, err)
    }
  }
}

// ─── withBackofficeAuth — backoffice token only (no user session needed) ─────

export function withBackofficeAuth(
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown> | void,
  methods?: Methods[],
  opts?: { requireRole?: AdminRole },
) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    setCORSHeaders(res, req)
    if (req.method === 'OPTIONS') return res.status(204).end()

    if (methods && !methods.includes(req.method as Methods)) {
      return methodNotAllowed(res)
    }

    try {
      const token = req.cookies['rook_backoffice']
        ?? req.headers.authorization?.replace('Bearer ', '')

      if (!token) return unauthorized(res, 'Acesso de backoffice necessário')

      const { verifyToken } = await import('./auth')
      const payload = await verifyToken(token) as Record<string, unknown> | null
      if (!payload || payload['admin'] !== true || payload['role'] !== 'backoffice') {
        return unauthorized(res, 'Token de backoffice inválido')
      }

      // Attach admin identity. Legacy/break-glass tokens have no adminRole →
      // treated as superadmin (see getBackofficeAdmin).
      const adminRole = (payload['adminRole'] === 'support' || payload['adminRole'] === 'superadmin')
        ? payload['adminRole'] as AdminRole : 'superadmin'
      const adminEmail = typeof payload['adminEmail'] === 'string' ? payload['adminEmail'] : 'legacy'
      ;(req as BackofficeRequest).admin = { email: adminEmail, role: adminRole }

      if (opts?.requireRole === 'superadmin' && adminRole !== 'superadmin') {
        return forbidden(res, 'Ação restrita a superadmin')
      }

      await handler(req, res)
    } catch (err) {
      serverError(res, err)
    }
  }
}

// ─── withPublic — public route with CORS ─────────────────────────────────────

export function withPublic(handler: PublicHandler, methods?: Methods[]) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    setCORSHeaders(res, req)
    if (req.method === 'OPTIONS') return res.status(204).end()

    if (methods && !methods.includes(req.method as Methods)) {
      return methodNotAllowed(res)
    }

    try {
      await handler(req, res)
    } catch (err) {
      serverError(res, err)
    }
  }
}

// ─── CORS headers ─────────────────────────────────────────────────────────────

function setCORSHeaders(res: NextApiResponse, req?: NextApiRequest) {
  const allowed = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3010,http://localhost:3020').split(',').map(o => o.trim())
  const origin  = req?.headers?.origin as string | undefined

  // Only allow explicitly whitelisted origins — reject unknown origins
  const allowOrigin = (origin && allowed.includes(origin)) ? origin : null
  if (!allowOrigin) {
    // No CORS headers for unrecognized origins — browser will block
    return
  }

  res.setHeader('Access-Control-Allow-Origin',      allowOrigin)
  res.setHeader('Access-Control-Allow-Methods',     'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers',     'Content-Type,Authorization')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Vary', 'Origin')
}
