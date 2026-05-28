import type { NextApiResponse } from 'next'

export function ok<T>(res: NextApiResponse, data: T, status = 200) {
  return res.status(status).json({ ok: true, data })
}

export function created<T>(res: NextApiResponse, data: T) {
  return ok(res, data, 201)
}

export function noContent(res: NextApiResponse) {
  return res.status(204).end()
}

export function badRequest(res: NextApiResponse, message: string, errors?: unknown) {
  return res.status(400).json({ ok: false, error: message, errors })
}

export function unauthorized(res: NextApiResponse, message = 'Não autenticado') {
  return res.status(401).json({ ok: false, error: message })
}

export function forbidden(res: NextApiResponse, message = 'Acesso negado') {
  return res.status(403).json({ ok: false, error: message })
}

export function notFound(res: NextApiResponse, message = 'Não encontrado') {
  return res.status(404).json({ ok: false, error: message })
}

export function methodNotAllowed(res: NextApiResponse) {
  return res.status(405).json({ ok: false, error: 'Método não permitido' })
}

export function serverError(res: NextApiResponse, err?: unknown) {
  console.error(err)
  return res.status(500).json({ ok: false, error: 'Erro interno do servidor' })
}
