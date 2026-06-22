import type { NextApiRequest, NextApiResponse } from 'next'
import Anthropic from '@anthropic-ai/sdk'
import { getSessionFromRequest } from '@/lib/auth'
import { db } from '@/lib/db'
import { parseISO, format, startOfMonth, endOfMonth } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { getLimits } from '@/lib/plans'

const client = new Anthropic()

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_summary',
    description: 'Retorna o resumo financeiro completo do mês atual: receitas, despesas, saldo, metas, contas pendentes, orçamento e categorias disponíveis.',
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
    description: 'Cadastra uma conta a pagar.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string' },
        amount: { type: 'number', description: 'Valor em reais' },
        dueDate: { type: 'string', description: 'Vencimento no formato YYYY-MM-DD' },
        isRecurring: { type: 'boolean', description: 'Se é uma conta recorrente mensal' },
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
      const { name: bName, amount, dueDate, isRecurring = false, categoryName } = input as { name: string; amount: number; dueDate: string; isRecurring?: boolean; categoryName?: string }
      const categoryId = categoryName ? (await findCategory(userId, categoryName)) : undefined
      await db.bill.create({ data: { name: bName, amount, dueDate: parseISO(dueDate), isRecurring, userId, ...(categoryId ? { categoryId } : {}) } })
      return `Conta "${bName}" de ${money(amount)} cadastrada para ${format(parseISO(dueDate), 'dd/MM/yyyy')}.`
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
  if (req.method !== 'POST') return res.status(405).end()

  const session = await getSessionFromRequest(req)
  if (!session) return res.status(401).json({ error: 'Não autenticado' })

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ai_unavailable', message: 'O assistente de IA está temporariamente indisponível.' })
  }

  const limits   = getLimits(session.plan ?? 'FREE')
  const yearMonth = format(new Date(), 'yyyy-MM')

  const user = await db.user.findUnique({
    where:  { id: session.userId },
    select: { plan: true, chatUsageMonth: true, chatUsageCount: true, name: true },
  })
  if (!user || user.plan !== 'PRO') return res.status(403).json({ error: 'pro_required', message: 'O assistente Rook é exclusivo do plano Pro.' })

  const currentCount = user.chatUsageMonth === yearMonth ? user.chatUsageCount : 0
  const monthLimit   = limits.chat ?? 30
  if (currentCount >= monthLimit) {
    return res.status(429).json({ error: 'rate_limited', message: `Limite de ${monthLimit} mensagens/mês atingido. Renova no próximo mês.`, remaining: 0 })
  }

  await db.user.update({
    where: { id: session.userId },
    data: { chatUsageMonth: yearMonth, chatUsageCount: currentCount + 1 },
  })

  const { messages } = req.body as { messages: Anthropic.MessageParam[] }
  const truncated = messages.slice(-10)
  const safeMessages = truncated[0]?.role === 'assistant' ? truncated.slice(1) : truncated

  const today  = format(new Date(), "EEEE, dd 'de' MMMM 'de' yyyy", { locale: ptBR })
  const todayISO = format(new Date(), 'yyyy-MM-dd')
  const system = `Você é o Rookinho, assistente financeiro do Rook Money.
Usuário: ${user.name ?? session.name}. Hoje: ${today} (${todayISO}).

FORMATO DE RESPOSTA (obrigatório):
- Texto puro, SEM markdown (nada de asteriscos, hashtags, listas com traço, blocos de código)
- Sem emojis excessivos (máximo 1 por resposta, apenas se fizer sentido)
- Máximo 2-3 frases curtas e diretas
- Valores sempre como R$ 1.234,56
- Datas como 22/06/2026
- Quando listar itens, separe com vírgula ou ponto-e-vírgula na mesma frase

COMPORTAMENTO:
- Português brasileiro, tom amigável e direto
- Sempre consulte os dados (get_summary, get_bills, etc) ANTES de responder sobre finanças
- Nunca invente dados
- Datas sem especificação = hoje (${todayISO})
- Ao registrar transações, deduza a categoria pelo contexto (ex: "almocei" = Alimentação)
- Se não conseguir resolver via ferramentas, sugira navegar para a página certa`

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
          remaining: monthLimit - (currentCount + 1),
        })
      }

      if (response.stop_reason === 'tool_use') {
        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[]
        const toolResults: Anthropic.ToolResultBlockParam[] = []
        for (const block of toolUseBlocks) {
          const result = await executeTool(block.name, block.input as Record<string, unknown>, session.userId)
          if (block.name === 'navigate') { try { navigationSuggestion = JSON.parse(result) } catch { /* */ } }
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

  return res.status(200).json({ message: 'Desculpe, não consegui processar sua mensagem. Tente reformular.', navigate: null, remaining: monthLimit - (currentCount + 1) })
}
