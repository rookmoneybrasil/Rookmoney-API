import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'

export default withBackofficeAuth(async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end()

  const users = await db.user.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, name: true, email: true, plan: true, isAdmin: true,
      createdAt: true, whatsappPhone: true,
      _count: { select: { transactions: true, goals: true, bills: true } },
    },
  })

  const header = 'ID,Nome,Email,Plano,Admin,WhatsApp,Transações,Metas,Contas,Cadastro\n'
  const rows   = users.map(u =>
    [
      u.id,
      `"${u.name.replace(/"/g, '""')}"`,
      u.email,
      u.plan,
      u.isAdmin ? 'Sim' : 'Não',
      u.whatsappPhone ?? '',
      u._count.transactions,
      u._count.goals,
      u._count.bills,
      new Date(u.createdAt).toLocaleDateString('pt-BR'),
    ].join(',')
  ).join('\n')

  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="usuarios-${new Date().toISOString().split('T')[0]}.csv"`)
  res.status(200).send('﻿' + header + rows) // BOM for Excel UTF-8
})
