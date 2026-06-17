import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, badRequest } from '@/lib/respond'

const DEFAULTS: Record<string, string> = {
  churn_alert_threshold: '5',
  admin_alert_email:     'viniguilherme013@gmail.com',
}

export default withBackofficeAuth(async (req, res) => {
  if (req.method === 'GET') {
    await Promise.all(
      Object.entries(DEFAULTS).map(([key, value]) =>
        db.appSetting.upsert({ where: { key }, update: {}, create: { key, value } })
      )
    )
    const rows = await db.appSetting.findMany()
    const result: Record<string, string> = {}
    for (const s of rows) result[s.key] = s.value
    return ok(res, result)
  }

  if (req.method === 'PATCH') {
    const { key, value } = req.body as { key?: string; value?: string }
    if (!key || value === undefined) return badRequest(res, 'key e value são obrigatórios.')
    await db.appSetting.upsert({
      where:  { key },
      update: { value: String(value) },
      create: { key, value: String(value) },
    })
    return ok(res, { key, value: String(value) })
  }

  return res.status(405).end()
}, ['GET', 'PATCH'])
