import type { NextApiRequest, NextApiResponse } from 'next'
import { db } from '@/lib/db'
import { ok, badRequest, notFound, serverError } from '@/lib/respond'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Método não permitido' })
  }

  const token = (req.query.token ?? req.body?.token) as string | undefined
  if (!token) return badRequest(res, 'Token obrigatório.')

  try {
    const subscriber = await db.newsletterSubscriber.findUnique({ where: { unsubscribeToken: token } })
    if (!subscriber) return notFound(res, 'Inscrição não encontrada.')

    await db.newsletterSubscriber.update({ where: { id: subscriber.id }, data: { isActive: false } })

    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      return res.status(200).send(`
        <!DOCTYPE html>
        <html><head><title>Cancelado</title></head>
        <body style="font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#0f172a;color:#f1f5f9">
          <div style="text-align:center">
            <h1 style="font-size:24px;margin-bottom:8px">Inscrição cancelada</h1>
            <p style="color:#94a3b8">Você não receberá mais emails da newsletter do Rook Money.</p>
            <a href="https://rookmoney.com/blog" style="color:#3b82f6;margin-top:16px;display:inline-block">Voltar ao blog</a>
          </div>
        </body></html>
      `)
    }

    return ok(res, { message: 'Inscrição cancelada com sucesso.' })
  } catch (err) {
    return serverError(res, err)
  }
}
