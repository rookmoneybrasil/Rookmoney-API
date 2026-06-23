import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, badRequest, planRequired } from '@/lib/respond'
import { getLimits } from '@/lib/plans'
import { parseISO, isValid, format } from 'date-fns'

type ImportRow = { date: string; description: string; amount: number; type: string; categoryId: string }

function normalizeType(raw: string): 'INCOME' | 'EXPENSE' | null {
  const v = raw.trim().toUpperCase()
  if (['INCOME', 'RECEITA', 'ENTRADA', 'C', 'CR', '+'].includes(v)) return 'INCOME'
  if (['EXPENSE', 'DESPESA', 'SAÍDA', 'SAIDA', 'D', 'DB', '-'].includes(v)) return 'EXPENSE'
  return null
}

export default withAuth(async (req, res, session) => {
  if (req.method !== 'POST') return res.status(405).end()

  const limits = getLimits(session.plan ?? 'FREE')
  if (!limits.import) return planRequired(res, 'Importação de dados')

  const rows = req.body?.rows as ImportRow[] | undefined
  if (!Array.isArray(rows) || !rows.length) return badRequest(res, 'Nenhuma transação para importar.')

  const validated: { userId: string; date: Date; description: string; amount: number; type: 'INCOME' | 'EXPENSE'; categoryId: string }[] = []
  const batchSeen = new Set<string>()

  for (const row of rows) {
    const parsedDate = parseISO(String(row.date ?? ''))
    if (!isValid(parsedDate)) continue
    if (!row.categoryId) continue
    if (typeof row.amount !== 'number' || isNaN(row.amount) || row.amount <= 0) continue
    const normalizedType = normalizeType(String(row.type ?? ''))
    if (!normalizedType) continue

    const description = row.description || 'Importado via CSV'
    const fingerprint = `${format(parsedDate, 'yyyy-MM-dd')}|${description}|${row.amount}|${normalizedType}`
    if (batchSeen.has(fingerprint)) continue
    batchSeen.add(fingerprint)

    const existing = await db.transaction.findFirst({
      where: {
        userId: session.userId,
        date: {
          gte: new Date(parsedDate.getFullYear(), parsedDate.getMonth(), parsedDate.getDate()),
          lte: new Date(parsedDate.getFullYear(), parsedDate.getMonth(), parsedDate.getDate(), 23, 59, 59),
        },
        description,
        type: normalizedType,
      },
      select: { id: true },
    })
    if (existing) continue

    validated.push({ userId: session.userId, date: parsedDate, description, amount: row.amount, type: normalizedType, categoryId: row.categoryId })
  }

  if (!validated.length) {
    return badRequest(res, 'Nenhuma transação nova encontrada. Possíveis motivos: formato inválido, tipo não reconhecido, ou transações já existentes.')
  }

  await db.transaction.createMany({ data: validated })

  return ok(res, { success: validated.length, skipped: rows.length - validated.length })
})
