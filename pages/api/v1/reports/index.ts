import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'
import { format, subMonths, startOfMonth, endOfMonth } from 'date-fns'
import { ptBR } from 'date-fns/locale'

export default withAuth(async (req, res, session) => {
  if (req.method !== 'GET') return res.status(405).end()

  const months  = Math.min(Math.max(Number(req.query.months ?? 6), 1), 24)
  const uid     = session.userId
  const now     = new Date()

  const monthly = await Promise.all(
    Array.from({ length: months }, (_, i) => {
      const d     = subMonths(now, months - 1 - i)
      const start = startOfMonth(d)
      const end   = endOfMonth(d)
      return Promise.all([
        db.transaction.aggregate({ where: { userId: uid, type: 'INCOME', date: { gte: start, lte: end } }, _sum: { amount: true } }),
        db.transaction.aggregate({ where: { userId: uid, type: 'EXPENSE', date: { gte: start, lte: end } }, _sum: { amount: true } }),
      ]).then(([inc, exp]) => ({
        monthKey:     format(d, 'yyyy-MM'),
        monthFull:    format(d, 'MMMM yyyy', { locale: ptBR }),
        totalIncome:  Number(inc._sum.amount ?? 0),
        totalExpense: Number(exp._sum.amount ?? 0),
        balance:      Number(inc._sum.amount ?? 0) - Number(exp._sum.amount ?? 0),
        savingsRate:  Number(inc._sum.amount ?? 0) > 0
          ? Math.round(((Number(inc._sum.amount ?? 0) - Number(exp._sum.amount ?? 0)) / Number(inc._sum.amount ?? 0)) * 100)
          : 0,
      }))
    })
  )

  const totalIncome  = monthly.reduce((s, m) => s + m.totalIncome, 0)
  const totalExpense = monthly.reduce((s, m) => s + m.totalExpense, 0)

  return ok(res, {
    monthly,
    period: {
      totalIncome, totalExpense,
      balance:     totalIncome - totalExpense,
      savingsRate: totalIncome > 0 ? Math.round(((totalIncome - totalExpense) / totalIncome) * 100) : 0,
    },
  })
})
