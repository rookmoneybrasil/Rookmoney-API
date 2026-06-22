import type { NextApiRequest, NextApiResponse } from 'next'
import Anthropic from '@anthropic-ai/sdk'
import { getSessionFromRequest } from '@/lib/auth'
import { db } from '@/lib/db'
import { parseISO, format, startOfMonth, endOfMonth, addMonths } from 'date-fns'
import { randomUUID } from 'crypto'
import { ptBR } from 'date-fns/locale'
import { getLimits, isPro } from '@/lib/plans'

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } }

const client = new Anthropic()

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_summary',
    description: 'Retorna o resumo financeiro completo do mês atual: receitas, despesas, saldo, metas, contas pendentes, orçamento e categorias disponíveis.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'analyze_finances',
    description: 'Analise financeira completa para dar conselhos personalizados. Retorna: renda total, gastos por categoria, contas fixas, parcelas, metas, dividas com pessoas, e historico dos ultimos 3 meses. Use quando o usuario pedir ajuda com planejamento, dicas, como organizar a renda, ou analise dos gastos.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_transactions',
    description: 'Lista transações recentes do usuário. Pode filtrar por tipo (INCOME/EXPENSE) e quantidade.',
    input_schema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', enum: ['INCOME', 'EXPENSE'], description: 'Filtrar por tipo' },
        limit: { type: 'number', description: 'Quantidade de transações (padrão: 10, máx: 20)' },
      },
      required: [],
    },
  },
  {
    name: 'get_bills',
    description: 'Lista contas a pagar pendentes e vencidas. Mostra nome, valor, vencimento e status.',
    input_schema: {
      type: 'object' as const,
      properties: {
        includeOverdue: { type: 'boolean', description: 'Incluir contas vencidas (padrão: true)' },
      },
      required: [],
    },
  },
  {
    name: 'get_goals',
    description: 'Lista todas as metas financeiras ativas com progresso atual.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_budget',
    description: 'Retorna o orçamento do mês atual por categoria com valor planejado vs gasto real.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_people',
    description: 'Lista pessoas com saldo devedor/credor. Mostra quem deve pra quem e quanto.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_income_sources',
    description: 'Lista fontes de renda do usuário (salário, freelance, aluguel etc).',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'add_transaction',
    description: 'Registra uma transação financeira (receita ou despesa). Use quando o usuário quiser anotar um gasto ou recebimento.',
    input_schema: {
      type: 'object' as const,
      properties: {
        amount: { type: 'number', description: 'Valor em reais (sempre positivo)' },
        type: { type: 'string', enum: ['INCOME', 'EXPENSE'] },
        description: { type: 'string', description: 'Descrição da transação' },
        date: { type: 'string', description: 'Data no formato YYYY-MM-DD' },
        categoryName: { type: 'string', description: 'Nome da categoria (ex: Alimentação, Transporte)' },
      },
      required: ['amount', 'type', 'description', 'date'],
    },
  },
  {
    name: 'add_goal',
    description: 'Cria uma nova meta financeira de economia.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string' },
        targetAmount: { type: 'number', description: 'Valor alvo em reais' },
        currentAmount: { type: 'number', description: 'Valor já guardado (padrão: 0)' },
        deadline: { type: 'string', description: 'Prazo no formato YYYY-MM-DD' },
        description: { type: 'string' },
      },
      required: ['name', 'targetAmount'],
    },
  },
  {
    name: 'add_bill',
    description: 'Cadastra uma conta a pagar. Suporta conta unica, parcelada ou recorrente. Para parcelada, informe installments (numero de parcelas) e alreadyPaid (parcelas ja pagas). O valor total e dividido igualmente entre as parcelas.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string' },
        amount: { type: 'number', description: 'Valor TOTAL em reais (sera dividido pelas parcelas se parcelado)' },
        dueDate: { type: 'string', description: 'Vencimento da primeira parcela no formato YYYY-MM-DD' },
        installments: { type: 'number', description: 'Numero de parcelas (1 = conta unica, 2+ = parcelado)' },
        alreadyPaid: { type: 'number', description: 'Parcelas ja pagas (ex: se esta na 3a de 12, alreadyPaid=2)' },
        isRecurring: { type: 'boolean', description: 'Se e uma conta recorrente mensal (nao usar junto com parcelas)' },
        categoryName: { type: 'string', description: 'Nome da categoria' },
      },
      required: ['name', 'amount', 'dueDate'],
    },
  },
  {
    name: 'pay_bill',
    description: 'Marca uma conta a pagar como paga. Use quando o usuário disser que pagou algo.',
    input_schema: {
      type: 'object' as const,
      properties: {
        billName: { type: 'string', description: 'Nome (ou parte) da conta a pagar' },
      },
      required: ['billName'],
    },
  },
  {
    name: 'contribute_to_goal',
    description: 'Adiciona uma contribuição a uma meta existente.',
    input_schema: {
      type: 'object' as const,
      properties: {
        goalName: { type: 'string', description: 'Nome (ou parte) da meta' },
        amount: { type: 'number', description: 'Valor a contribuir em reais' },
      },
      required: ['goalName', 'amount'],
    },
  },
  {
    name: 'add_income_source',
    description: 'Cadastra uma nova fonte de renda (salário, freelance, aluguel, etc). Use quando o usuário disser que recebe de algum lugar.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Nome da fonte (ex: Salário Empresa X, Freelance, Aluguel)' },
        amount: { type: 'number', description: 'Valor mensal em reais' },
        type: { type: 'string', enum: ['EMPLOYMENT', 'FREELANCE', 'RENTAL', 'OTHER'], description: 'Tipo: EMPLOYMENT=emprego, FREELANCE=freelance, RENTAL=aluguel, OTHER=outro' },
        isRecurring: { type: 'boolean', description: 'Se é recorrente mensal (padrão: true)' },
        dayOfMonth: { type: 'number', description: 'Dia do mês que recebe (1-31)' },
        categoryName: { type: 'string', description: 'Nome da categoria' },
      },
      required: ['name', 'amount'],
    },
  },
  {
    name: 'add_person',
    description: 'Cadastra uma nova pessoa para controle de dívidas (quem me deve / quem eu devo). Use quando o usuário mencionar alguém novo.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Nome da pessoa' },
        notes: { type: 'string', description: 'Observações opcionais' },
      },
      required: ['name'],
    },
  },
  {
    name: 'add_person_entry',
    description: 'Registra uma dívida ou crédito com uma pessoa. Use quando alguém empresta ou deve dinheiro.',
    input_schema: {
      type: 'object' as const,
      properties: {
        personName: { type: 'string', description: 'Nome da pessoa (busca por nome parcial)' },
        type: { type: 'string', enum: ['THEY_OWE_ME', 'I_OWE_THEM'], description: 'THEY_OWE_ME = pessoa me deve, I_OWE_THEM = eu devo pra pessoa' },
        description: { type: 'string', description: 'Descrição (ex: almoço, empréstimo, conta de luz)' },
        amount: { type: 'number', description: 'Valor em reais' },
        date: { type: 'string', description: 'Data no formato YYYY-MM-DD' },
      },
      required: ['personName', 'type', 'description', 'amount', 'date'],
    },
  },
  {
    name: 'add_recurring_bill',
    description: 'Cria um modelo de conta recorrente que gera contas automaticamente todo mês. Use para contas fixas mensais como aluguel, internet, streaming.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Nome da conta (ex: Aluguel, Netflix, Internet)' },
        amount: { type: 'number', description: 'Valor mensal em reais' },
        dayOfMonth: { type: 'number', description: 'Dia do vencimento (1-28)' },
        categoryName: { type: 'string', description: 'Nome da categoria' },
      },
      required: ['name', 'amount', 'dayOfMonth'],
    },
  },
  {
    name: 'navigate',
    description: 'Sugere navegar para uma página específica do app. Use quando a ação do usuário seria melhor realizada em uma tela específica.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', enum: ['/dashboard', '/transactions', '/goals', '/bills', '/budget', '/reports', '/people', '/categories', '/recurring', '/income', '/settings', '/billing'] },
        reason: { type: 'string', description: 'Motivo da sugestão de navegação' },
      },
      required: ['path', 'reason'],
    },
  },
]

async function findCategory(userId: string, name?: string): Promise<string | undefined> {
  if (name) {
    const cat = await db.category.findFirst({ where: { name: { contains: name, mode: 'insensitive' }, OR: [{ isDefault: true }, { userId }] } })
    if (cat) return cat.id
  }
  const fallback = await db.category.findFirst({ where: { OR: [{ isDefault: true }, { userId }] }, orderBy: { isDefault: 'desc' } })
  return fallback?.id
}

function money(v: unknown): string {
  return `R$ ${Number(v ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtDate(d: Date): string {
  return format(d, 'dd/MM/yyyy', { locale: ptBR })
}

async function executeTool(name: string, input: Record<string, unknown>, userId: string): Promise<string> {
  try {
    const now = new Date()
    const monthStart = startOfMonth(now)
    const monthEnd = endOfMonth(now)

    if (name === 'get_summary') {
      const [income, expense, goals, bills, budgets, categories] = await Promise.all([
        db.transaction.aggregate({ where: { userId, type: 'INCOME', date: { gte: monthStart, lte: monthEnd } }, _sum: { amount: true } }),
        db.transaction.aggregate({ where: { userId, type: 'EXPENSE', date: { gte: monthStart, lte: monthEnd } }, _sum: { amount: true } }),
        db.goal.findMany({ where: { userId, isCompleted: false }, select: { name: true, currentAmount: true, targetAmount: true, deadline: true }, take: 5 }),
        db.bill.findMany({ where: { userId, isPaid: false }, select: { name: true, amount: true, dueDate: true }, take: 10, orderBy: { dueDate: 'asc' } }),
        db.budget.findMany({ where: { userId, month: format(now, 'yyyy-MM') }, select: { amount: true, category: { select: { name: true } } } }),
        db.category.findMany({ where: { OR: [{ isDefault: true }, { userId }] }, select: { name: true }, take: 30 }),
      ])
      const ti = Number(income._sum.amount ?? 0), te = Number(expense._sum.amount ?? 0)
      return JSON.stringify({
        month: format(now, 'MMMM yyyy', { locale: ptBR }),
        totalIncome: money(ti),
        totalExpense: money(te),
        balance: money(ti - te),
        savingsRate: ti > 0 ? `${Math.round(((ti - te) / ti) * 100)}%` : '0%',
        goals: goals.map(g => ({ name: g.name, current: money(g.currentAmount), target: money(g.targetAmount), progress: `${Math.round((Number(g.currentAmount) / Number(g.targetAmount)) * 100)}%`, deadline: g.deadline ? fmtDate(g.deadline) : null })),
        pendingBills: bills.map(b => ({ name: b.name, amount: money(b.amount), due: fmtDate(b.dueDate), overdue: b.dueDate < now })),
        budgets: budgets.map(b => ({ category: b.category.name, planned: money(b.amount) })),
        availableCategories: categories.map(c => c.name),
      })
    }

    if (name === 'analyze_finances') {
      const threeMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 2, 1)

      const [incomeSources, recurringBills, pendingBills, goals, people, monthlyHistory, categoryBreakdown] = await Promise.all([
        db.incomeSource.findMany({
          where: { userId },
          select: { name: true, amount: true, type: true, isRecurring: true, dayOfMonth: true },
        }),
        db.recurringBill.findMany({
          where: { userId, isActive: true },
          select: { name: true, amount: true, dayOfMonth: true, category: { select: { name: true } } },
        }),
        db.bill.findMany({
          where: { userId, isPaid: false },
          select: { name: true, amount: true, dueDate: true, installmentTotal: true, installmentCurrent: true },
          orderBy: { dueDate: 'asc' },
          take: 20,
        }),
        db.goal.findMany({
          where: { userId, isCompleted: false },
          select: { name: true, targetAmount: true, currentAmount: true, deadline: true },
        }),
        db.person.findMany({
          where: { userId },
          select: {
            name: true,
            entries: { where: { isSettled: false }, select: { type: true, amount: true } },
          },
        }),
        // Monthly totals for last 3 months
        db.$queryRawUnsafe<{ month: string; type: string; total: number }[]>(
          `SELECT to_char(date, 'YYYY-MM') as month, type, SUM(amount)::float as total
           FROM "Transaction" WHERE "userId" = $1 AND date >= $2
           GROUP BY month, type ORDER BY month`,
          userId, threeMonthsAgo
        ).catch(() => []),
        // Spending by category this month
        db.$queryRawUnsafe<{ name: string; total: number }[]>(
          `SELECT c.name, SUM(t.amount)::float as total
           FROM "Transaction" t JOIN "Category" c ON t."categoryId" = c.id
           WHERE t."userId" = $1 AND t.type = 'EXPENSE' AND t.date >= $2 AND t.date <= $3
           GROUP BY c.name ORDER BY total DESC`,
          userId, monthStart, monthEnd
        ).catch(() => []),
      ])

      const totalMonthlyIncome = incomeSources.reduce((s, src) => s + Number(src.amount), 0)
      const totalFixedExpenses = recurringBills.reduce((s, rb) => s + Number(rb.amount), 0)
      const totalPendingBills = pendingBills.reduce((s, b) => s + Number(b.amount), 0)

      const peopleDebts = people.filter(p => p.entries.length > 0).map(p => {
        const theyOwe = p.entries.filter(e => e.type === 'THEY_OWE_ME').reduce((s, e) => s + Number(e.amount), 0)
        const iOwe = p.entries.filter(e => e.type === 'I_OWE_THEM').reduce((s, e) => s + Number(e.amount), 0)
        return { name: p.name, theyOweMe: theyOwe, iOweThem: iOwe }
      })
      const totalReceivable = peopleDebts.reduce((s, p) => s + p.theyOweMe, 0)
      const totalPayable = peopleDebts.reduce((s, p) => s + p.iOweThem, 0)

      return JSON.stringify({
        rendaMensal: {
          total: money(totalMonthlyIncome),
          fontes: incomeSources.map(s => ({ nome: s.name, valor: money(s.amount), tipo: s.type, recorrente: s.isRecurring })),
        },
        gastosFixosMensais: {
          total: money(totalFixedExpenses),
          contas: recurringBills.map(rb => ({ nome: rb.name, valor: money(rb.amount), dia: rb.dayOfMonth, categoria: rb.category?.name ?? null })),
        },
        gastosPorCategoriaMesAtual: categoryBreakdown.map(c => ({ categoria: c.name, valor: money(c.total) })),
        contasPendentes: {
          total: money(totalPendingBills),
          items: pendingBills.map(b => ({
            nome: b.name, valor: money(b.amount), vencimento: fmtDate(b.dueDate),
            parcela: b.installmentTotal ? `${b.installmentCurrent}/${b.installmentTotal}` : null,
          })),
        },
        metas: goals.map(g => ({
          nome: g.name, alvo: money(g.targetAmount), atual: money(g.currentAmount),
          falta: money(Number(g.targetAmount) - Number(g.currentAmount)),
          prazo: g.deadline ? fmtDate(g.deadline) : null,
        })),
        pessoas: peopleDebts.length > 0 ? { aReceber: money(totalReceivable), aPagar: money(totalPayable), detalhe: peopleDebts.map(p => ({ nome: p.name, meDevem: money(p.theyOweMe), euDevo: money(p.iOweThem) })) } : null,
        historicoMensal: monthlyHistory.reduce((acc, row) => {
          if (!acc[row.month]) acc[row.month] = { receita: 0, despesa: 0 }
          if (row.type === 'INCOME') acc[row.month].receita = row.total
          if (row.type === 'EXPENSE') acc[row.month].despesa = row.total
          return acc
        }, {} as Record<string, { receita: number; despesa: number }>),
        sobra: money(totalMonthlyIncome - totalFixedExpenses),
        percentualFixo: totalMonthlyIncome > 0 ? `${Math.round((totalFixedExpenses / totalMonthlyIncome) * 100)}%` : 'N/A',
      })
    }

    if (name === 'get_transactions') {
      const { type, limit: lim } = input as { type?: string; limit?: number }
      const take = Math.min(lim ?? 10, 20)
      const where: Record<string, unknown> = { userId }
      if (type) where.type = type
      const txs = await db.transaction.findMany({
        where, take, orderBy: { date: 'desc' },
        select: { amount: true, type: true, description: true, date: true, category: { select: { name: true, icon: true } } },
      })
      return JSON.stringify(txs.map(t => ({
        description: t.description ?? '(sem descrição)',
        amount: money(t.amount),
        type: t.type,
        date: fmtDate(t.date),
        category: `${t.category.icon} ${t.category.name}`,
      })))
    }

    if (name === 'get_bills') {
      const includeOverdue = (input as { includeOverdue?: boolean }).includeOverdue !== false
      const where: Record<string, unknown> = { userId, isPaid: false }
      if (!includeOverdue) where.dueDate = { gte: now }
      const bills = await db.bill.findMany({
        where, take: 15, orderBy: { dueDate: 'asc' },
        select: { name: true, amount: true, dueDate: true, category: { select: { name: true } } },
      })
      const overdue = bills.filter(b => b.dueDate < now)
      const upcoming = bills.filter(b => b.dueDate >= now)
      return JSON.stringify({
        overdue: overdue.map(b => ({ name: b.name, amount: money(b.amount), due: fmtDate(b.dueDate), category: b.category?.name ?? null, daysLate: Math.floor((now.getTime() - b.dueDate.getTime()) / 86400000) })),
        upcoming: upcoming.map(b => ({ name: b.name, amount: money(b.amount), due: fmtDate(b.dueDate), category: b.category?.name ?? null })),
        totalPending: money(bills.reduce((s, b) => s + Number(b.amount), 0)),
      })
    }

    if (name === 'get_goals') {
      const goals = await db.goal.findMany({
        where: { userId, isCompleted: false },
        select: { name: true, targetAmount: true, currentAmount: true, deadline: true, description: true },
        orderBy: { createdAt: 'desc' },
      })
      return JSON.stringify(goals.map(g => ({
        name: g.name,
        current: money(g.currentAmount),
        target: money(g.targetAmount),
        remaining: money(Number(g.targetAmount) - Number(g.currentAmount)),
        progress: `${Math.round((Number(g.currentAmount) / Number(g.targetAmount)) * 100)}%`,
        deadline: g.deadline ? fmtDate(g.deadline) : null,
        description: g.description,
      })))
    }

    if (name === 'get_budget') {
      const month = format(now, 'yyyy-MM')
      const budgets = await db.budget.findMany({
        where: { userId, month },
        select: { amount: true, category: { select: { id: true, name: true, icon: true } } },
      })
      const spentByCategory = await Promise.all(
        budgets.map(async b => {
          const spent = await db.transaction.aggregate({
            where: { userId, type: 'EXPENSE', categoryId: b.category.id, date: { gte: monthStart, lte: monthEnd } },
            _sum: { amount: true },
          })
          return { category: `${b.category.icon} ${b.category.name}`, planned: money(b.amount), spent: money(spent._sum.amount), remaining: money(Number(b.amount) - Number(spent._sum.amount ?? 0)), overBudget: Number(spent._sum.amount ?? 0) > Number(b.amount) }
        })
      )
      return JSON.stringify(spentByCategory.length ? spentByCategory : 'Nenhum orçamento configurado para este mês.')
    }

    if (name === 'get_people') {
      const people = await db.person.findMany({
        where: { userId },
        select: {
          name: true,
          entries: { where: { isSettled: false }, select: { type: true, amount: true, description: true } },
        },
      })
      return JSON.stringify(people.filter(p => p.entries.length > 0).map(p => {
        const theyOwe = p.entries.filter(e => e.type === 'THEY_OWE_ME').reduce((s, e) => s + Number(e.amount), 0)
        const iOwe = p.entries.filter(e => e.type === 'I_OWE_THEM').reduce((s, e) => s + Number(e.amount), 0)
        return { name: p.name, theyOweMe: money(theyOwe), iOweThem: money(iOwe), balance: money(theyOwe - iOwe), entries: p.entries.map(e => ({ type: e.type === 'THEY_OWE_ME' ? 'me deve' : 'eu devo', description: e.description, amount: money(e.amount) })) }
      }))
    }

    if (name === 'get_income_sources') {
      const sources = await db.incomeSource.findMany({
        where: { userId },
        select: { name: true, type: true, amount: true, isRecurring: true, dayOfMonth: true, category: { select: { name: true } } },
      })
      return JSON.stringify(sources.map(s => ({
        name: s.name,
        amount: money(s.amount),
        type: s.type,
        recurring: s.isRecurring ? `Dia ${s.dayOfMonth ?? '?'} de cada mês` : 'Avulsa',
        category: s.category?.name ?? null,
      })))
    }

    if (name === 'add_transaction') {
      const { amount, type, description, date, categoryName } = input as { amount: number; type: string; description: string; date: string; categoryName?: string }
      const categoryId = await findCategory(userId, categoryName)
      if (!categoryId) return 'Erro: nenhuma categoria disponível.'
      await db.transaction.create({ data: { amount: Math.abs(amount), type: type as 'INCOME' | 'EXPENSE', description: description ?? '', date: parseISO(date), userId, categoryId } })
      return `Transação "${description}" de ${money(Math.abs(amount))} registrada com sucesso.`
    }

    if (name === 'add_goal') {
      const { name: gName, targetAmount, currentAmount = 0, deadline, description } = input as { name: string; targetAmount: number; currentAmount?: number; deadline?: string; description?: string }
      await db.goal.create({ data: { name: gName, targetAmount, currentAmount: currentAmount ?? 0, deadline: deadline ? parseISO(deadline) : null, description: description ?? null, userId } })
      return `Meta "${gName}" criada com alvo de ${money(targetAmount)}.`
    }

    if (name === 'add_bill') {
      const { name: bName, amount, dueDate, installments = 1, alreadyPaid = 0, isRecurring = false, categoryName } = input as { name: string; amount: number; dueDate: string; installments?: number; alreadyPaid?: number; isRecurring?: boolean; categoryName?: string }
      const categoryId = categoryName ? (await findCategory(userId, categoryName)) : undefined
      const baseDate = parseISO(dueDate)
      const numTotal = Math.max(1, Math.round(installments))
      const numAlreadyPaid = Math.max(0, Math.min(Math.round(alreadyPaid), numTotal - 1))
      const numToCreate = numTotal > 1 ? numTotal - numAlreadyPaid : 1

      if (numTotal > 1) {
        const groupId = randomUUID()
        const baseInstallment = Math.floor((amount / numToCreate) * 100) / 100
        const lastInstallment = Math.round((amount - baseInstallment * (numToCreate - 1)) * 100) / 100
        await db.bill.createMany({
          data: Array.from({ length: numToCreate }, (_, i) => ({
            name: bName,
            amount: i === numToCreate - 1 ? lastInstallment : baseInstallment,
            dueDate: addMonths(baseDate, i),
            userId,
            categoryId: categoryId ?? null,
            isRecurring: false,
            installmentTotal: numTotal,
            installmentCurrent: numAlreadyPaid + i + 1,
            installmentGroupId: groupId,
          })),
        })
        return `Conta "${bName}" parcelada em ${numTotal}x de ${money(amount / numToCreate)} cadastrada${numAlreadyPaid > 0 ? ` (${numAlreadyPaid} parcelas ja pagas, ${numToCreate} restantes)` : ''}. Primeira parcela em ${fmtDate(baseDate)}.`
      }

      await db.bill.create({ data: { name: bName, amount, dueDate: baseDate, isRecurring, userId, ...(categoryId ? { categoryId } : {}) } })
      return `Conta "${bName}" de ${money(amount)} cadastrada para ${fmtDate(baseDate)}.`
    }

    if (name === 'pay_bill') {
      const { billName } = input as { billName: string }
      const bill = await db.bill.findFirst({
        where: { userId, isPaid: false, name: { contains: billName, mode: 'insensitive' } },
        orderBy: { dueDate: 'asc' },
      })
      if (!bill) return `Não encontrei conta pendente com nome "${billName}".`
      await db.bill.update({ where: { id: bill.id }, data: { isPaid: true, paidAt: new Date() } })
      return `Conta "${bill.name}" de ${money(bill.amount)} marcada como paga!`
    }

    if (name === 'contribute_to_goal') {
      const { goalName, amount } = input as { goalName: string; amount: number }
      const goal = await db.goal.findFirst({
        where: { userId, isCompleted: false, name: { contains: goalName, mode: 'insensitive' } },
      })
      if (!goal) return `Não encontrei meta ativa com nome "${goalName}".`
      const newAmount = Number(goal.currentAmount) + Math.abs(amount)
      const isCompleted = newAmount >= Number(goal.targetAmount)
      await db.goal.update({ where: { id: goal.id }, data: { currentAmount: newAmount, ...(isCompleted ? { isCompleted: true, completedAt: new Date() } : {}) } })
      await db.goalContribution.create({ data: { goalId: goal.id, amount: Math.abs(amount) } })
      if (isCompleted) return `Contribuição de ${money(amount)} adicionada! Meta "${goal.name}" foi COMPLETADA! Parabéns! 🎉`
      return `Contribuição de ${money(amount)} adicionada à meta "${goal.name}". Progresso: ${money(newAmount)} de ${money(goal.targetAmount)} (${Math.round((newAmount / Number(goal.targetAmount)) * 100)}%).`
    }

    if (name === 'add_income_source') {
      const { name: sName, amount, type: sType = 'OTHER', isRecurring = true, dayOfMonth, categoryName } = input as { name: string; amount: number; type?: string; isRecurring?: boolean; dayOfMonth?: number; categoryName?: string }
      const categoryId = categoryName ? (await findCategory(userId, categoryName)) : undefined
      await db.incomeSource.create({
        data: { name: sName, amount: Math.abs(amount), type: sType as 'EMPLOYMENT' | 'FREELANCE' | 'RENTAL' | 'OTHER', isRecurring, dayOfMonth: dayOfMonth ?? null, userId, ...(categoryId ? { categoryId } : {}) },
      })
      return `Renda "${sName}" de ${money(amount)}/mês cadastrada${dayOfMonth ? ` (dia ${dayOfMonth})` : ''}.`
    }

    if (name === 'add_person') {
      const { name: pName, notes } = input as { name: string; notes?: string }
      const existing = await db.person.findFirst({ where: { userId, name: { contains: pName, mode: 'insensitive' } } })
      if (existing) return `A pessoa "${existing.name}" já está cadastrada.`
      await db.person.create({ data: { name: pName, notes: notes ?? null, userId } })
      return `Pessoa "${pName}" cadastrada.`
    }

    if (name === 'add_person_entry') {
      const { personName, type: eType, description: desc, amount, date } = input as { personName: string; type: string; description: string; amount: number; date: string }
      let person = await db.person.findFirst({ where: { userId, name: { contains: personName, mode: 'insensitive' } } })
      if (!person) {
        person = await db.person.create({ data: { name: personName, userId } })
      }
      await db.personEntry.create({
        data: { type: eType as 'THEY_OWE_ME' | 'I_OWE_THEM', description: desc, amount: Math.abs(amount), date: parseISO(date), personId: person.id, userId },
      })
      const label = eType === 'THEY_OWE_ME' ? `${person.name} te deve` : `Voce deve pra ${person.name}`
      return `Registrado: ${label} ${money(amount)} (${desc}).`
    }

    if (name === 'add_recurring_bill') {
      const { name: rbName, amount, dayOfMonth, categoryName } = input as { name: string; amount: number; dayOfMonth: number; categoryName?: string }
      const categoryId = categoryName ? (await findCategory(userId, categoryName)) : undefined
      await db.recurringBill.create({
        data: { name: rbName, amount: Math.abs(amount), dayOfMonth: Math.min(Math.max(dayOfMonth, 1), 28), userId, ...(categoryId ? { categoryId } : {}) },
      })
      return `Conta recorrente "${rbName}" de ${money(amount)}/mês (dia ${dayOfMonth}) cadastrada. Vai gerar contas automaticamente todo mês.`
    }

    if (name === 'navigate') {
      const { path, reason } = input as { path: string; reason: string }
      return JSON.stringify({ navigate: path, reason })
    }

    return 'Ferramenta não reconhecida.'
  } catch (err) {
    return `Erro: ${err instanceof Error ? err.message : 'desconhecido'}`
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req)
  if (!session) return res.status(401).json({ error: 'Não autenticado' })

  const limits   = getLimits(session.plan ?? 'FREE')
  const yearMonth = format(new Date(), 'yyyy-MM')

  const user = await db.user.findUnique({
    where:  { id: session.userId },
    select: { plan: true, chatUsageMonth: true, chatUsageCount: true, chatFileMonth: true, chatFileCount: true, chatAnalysisMonth: true, chatAnalysisCount: true, name: true },
  })
  if (!user || !isPro(user.plan)) return res.status(403).json({ error: 'pro_required', message: 'O assistente Rook é exclusivo do plano Pro.' })

  const chatCount     = user.chatUsageMonth === yearMonth ? user.chatUsageCount : 0
  const fileCount     = user.chatFileMonth === yearMonth ? user.chatFileCount : 0
  const analysisCount = user.chatAnalysisMonth === yearMonth ? user.chatAnalysisCount : 0
  const chatLimit     = limits.chat
  const fileLimit     = limits.chatFiles
  const analysisLimit = limits.chatAnalysis

  if (req.method === 'GET') {
    return res.status(200).json({
      used: chatCount, limit: chatLimit ?? 999, remaining: chatLimit ? chatLimit - chatCount : 999,
      files: { used: fileCount, limit: fileLimit ?? 999 },
      analysis: { used: analysisCount, limit: analysisLimit ?? 999 },
    })
  }

  if (req.method !== 'POST') return res.status(405).end()

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ai_unavailable', message: 'O assistente de IA está temporariamente indisponível.' })
  }

  if (chatLimit && chatCount >= chatLimit) {
    return res.status(429).json({ error: 'rate_limited', message: `Limite de ${chatLimit} mensagens/mês atingido. Renova no próximo mês.`, remaining: 0 })
  }

  // Check if message has image/document (file upload)
  const { messages } = req.body as { messages: Anthropic.MessageParam[] }
  const lastMsg = messages[messages.length - 1]
  const hasFile = Array.isArray(lastMsg?.content) && (lastMsg.content as unknown[]).some((b: unknown) => {
    const block = b as { type?: string }
    return block.type === 'image' || block.type === 'document'
  })
  if (hasFile && fileLimit && fileCount >= fileLimit) {
    return res.status(429).json({ error: 'file_limit', message: `Limite de ${fileLimit} arquivos/mês atingido. Faça upgrade pro Pro+ para envio ilimitado.` })
  }

  await db.user.update({
    where: { id: session.userId },
    data: {
      chatUsageMonth: yearMonth, chatUsageCount: chatCount + 1,
      ...(hasFile ? { chatFileMonth: yearMonth, chatFileCount: fileCount + 1 } : {}),
    },
  })

  const truncated = messages.slice(-10)
  const safeMessages = truncated[0]?.role === 'assistant' ? truncated.slice(1) : truncated

  const today  = format(new Date(), "EEEE, dd 'de' MMMM 'de' yyyy", { locale: ptBR })
  const todayISO = format(new Date(), 'yyyy-MM-dd')
  const system = `Voce e o Rookinho, o touro azul mascote do Rook Money — assistente financeiro com personalidade.
Usuario: ${user.name ?? session.name}. Hoje: ${today} (${todayISO}).

PERSONALIDADE (muito importante):
Voce e debochado, bem-humorado e direto. Faz piadinhas sobre os gastos do usuario de forma leve e carinhosa, nunca ofensivo. Exemplos do seu jeito:
- Quando gasta muito: "Eita ${user.name ?? 'amigo'}, ta gastando mais que deputado hein hahaha"
- Delivery alto: "R$ 500 em iFood... ta alimentando o bairro inteiro?"
- Economizou: "Opa, ta guardando dinheiro? To ate emocionado aqui"
- Conta vencida: "Conta vencida de novo? Assim voce me deixa triste ein"
- Pagou em dia: "Boa! Pagando certinho, to orgulhoso de voce"
- Meta batida: "CONSEGUIU! Bora comemorar (mas sem gastar muito ne hahaha)"
Misture sempre humor com as dicas. Zoe com carinho nos gastos, comemore as conquistas.
NUNCA use girias como "mano", "ta ligado", "parça", "bro", "meu chapa", "firmeza". Fale de forma natural e acessivel, como um amigo educado que gosta de zoar.

FORMATO DE RESPOSTA (obrigatorio):
- SEM markdown pesado (nada de asteriscos duplos, hashtags, blocos de codigo)
- Use quebras de linha para separar ideias diferentes
- Quando listar itens (contas, transacoes, dicas), use bullets com "• " no inicio de cada linha
- Maximo 1-2 emojis por resposta, so se combinar
- Valores sempre como R$ 1.234,56
- Datas como 22/06/2026
Exemplo de formato bom:
Seu resumo de junho:
• Receita: R$ 9.500,00
• Despesas: R$ 6.792,01
• Saldo: R$ 2.707,99

Voce tem 2 contas vencidas, recomendo quitar logo!

COMPORTAMENTO:
- Portugues brasileiro, tom amigavel e zoeiro
- Sempre consulte os dados (get_summary, get_bills, etc) ANTES de responder sobre financas
- Nunca invente dados
- Datas sem especificacao = hoje (${todayISO})
- Ao registrar transacoes, deduza a categoria pelo contexto (ex: "almocei" = Alimentacao)
- Se nao conseguir resolver via ferramentas, sugira navegar para a pagina certa

ANALISE E PLANEJAMENTO FINANCEIRO:
Quando o usuario pedir ajuda com organizacao, planejamento, dicas ou analise de gastos, use analyze_finances para puxar todos os dados. Com base nos dados reais, de conselhos PRATICOS e ESPECIFICOS:
- Sugira percentuais ideais por categoria (ex: alimentacao ate 30% da renda, moradia ate 30%, lazer ate 10%, poupanca minimo 20%)
- Compare o que o usuario gasta vs o ideal e aponte onde ajustar
- Se tiver metas, calcule quanto precisa guardar por mes pra atingir no prazo
- Se tiver contas vencidas, alerte e priorize
- Seja especifico com valores reais, nao generico (ex: "voce pode gastar ate R$ 2.850 com moradia" e nao "gaste menos")
Para analises mais longas, pode usar ate 5-6 frases (excecao a regra de 2-3 frases).

CADASTRO GUIADO (muito importante):
Quando o usuario quiser cadastrar algo mas nao der todas as informacoes, PERGUNTE o que falta antes de criar. Exemplos:
- "quero adicionar uma conta" -> pergunte: nome, valor, vencimento, e se e parcelada (quantas parcelas)
- "comprei um celular parcelado" -> pergunte: valor total, quantas parcelas, ja pagou alguma, vencimento da proxima
- "tenho uma renda nova" -> pergunte: nome, valor, dia que recebe e se e recorrente
- "o Joao me deve" -> pergunte: quanto e referente a que
- "gastei no mercado" -> pergunte: quanto gastou
- "quero cadastrar conta fixa" -> use add_recurring_bill (gera automaticamente todo mes)
Pergunte tudo que falta em UMA mensagem so, de forma natural. Nunca crie registros com dados inventados.
Para contas parceladas, pergunte: valor total, numero de parcelas, quantas ja foram pagas, e data da proxima parcela.

IMAGENS, PDFs E COMPROVANTES:
Quando o usuario enviar uma imagem ou PDF (comprovante, nota fiscal, boleto, extrato, recibo, fatura), analise o conteudo e:
- Extraia valores, datas, descricoes e categorias
- Pergunte se quer registrar como transacao, conta a pagar, etc
- Se for um comprovante de pagamento, pergunte se quer marcar alguma conta como paga
- Se for um boleto, extraia nome, valor e vencimento e ofereca cadastrar
- Se nao conseguir ler a imagem claramente, peca uma foto melhor`

  let currentMessages: Anthropic.MessageParam[] = [...safeMessages]
  let navigationSuggestion: { path: string; reason: string } | null = null

  try {
    for (let i = 0; i < 5; i++) {
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system,
        tools: TOOLS,
        messages: currentMessages,
      })

      if (response.stop_reason === 'end_turn') {
        const text = response.content.find(b => b.type === 'text')?.text ?? ''
        return res.status(200).json({
          message: text,
          navigate: navigationSuggestion,
          remaining: chatLimit ? chatLimit - (chatCount + 1) : 999,
        })
      }

      if (response.stop_reason === 'tool_use') {
        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[]
        const toolResults: Anthropic.ToolResultBlockParam[] = []
        for (const block of toolUseBlocks) {
          if (block.name === 'analyze_finances' && analysisLimit && analysisCount >= analysisLimit) {
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Limite de ${analysisLimit} análises/mês atingido. Faça upgrade pro Pro+ para análises ilimitadas.` })
            continue
          }
          const result = await executeTool(block.name, block.input as Record<string, unknown>, session.userId)
          if (block.name === 'navigate') { try { navigationSuggestion = JSON.parse(result) } catch { /* */ } }
          if (block.name === 'analyze_finances') {
            await db.user.update({ where: { id: session.userId }, data: { chatAnalysisMonth: yearMonth, chatAnalysisCount: analysisCount + 1 } })
          }
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
        }
        currentMessages = [...currentMessages, { role: 'assistant', content: response.content }, { role: 'user', content: toolResults }]
        continue
      }
      break
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    if (msg.includes('authentication') || msg.includes('api_key')) {
      return res.status(503).json({ error: 'ai_unavailable', message: 'O assistente de IA está temporariamente indisponível.' })
    }
    if (msg.includes('credit balance') || msg.includes('billing')) {
      return res.status(503).json({ error: 'ai_unavailable', message: 'O assistente de IA está temporariamente indisponível. Tente novamente mais tarde.' })
    }
    return res.status(500).json({ error: 'ai_error', message: 'Erro ao processar sua mensagem. Tente novamente.' })
  }

  return res.status(200).json({ message: 'Desculpe, não consegui processar sua mensagem. Tente reformular.', navigate: null, remaining: chatLimit ? chatLimit - (chatCount + 1) : 999 })
}
