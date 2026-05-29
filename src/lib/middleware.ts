import type { NextApiRequest, NextApiResponse } from 'next'
import { getSessionFromRequest, type Session } from './auth'
import { unauthorized, serverError, methodNotAllowed } from './respond'
import { db } from './db'

type Methods = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

type AuthHandler = (
  req:     NextApiRequest,
  res:     NextApiResponse,
  session: Session,
) => Promise<void> | void

type PublicHandler = (
  req: NextApiRequest,
  res: NextApiResponse,
) => Promise<void> | void

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
      await handler(req, res, session)
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

export function withBackofficeAuth(handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void> | void, methods?: Methods[]) {
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

  // Set origin to the matched allowed origin, or first allowed if no match (dev fallback)
  const allowOrigin = (origin && allowed.includes(origin)) ? origin : allowed[0]

  res.setHeader('Access-Control-Allow-Origin',      allowOrigin)
  res.setHeader('Access-Control-Allow-Methods',     'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers',     'Content-Type,Authorization')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Vary', 'Origin')
}
