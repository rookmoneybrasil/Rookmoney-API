import type { NextApiRequest, NextApiResponse } from 'next'
import Anthropic from '@anthropic-ai/sdk'
import { getSessionFromRequest } from '@/lib/auth'
import { db } from '@/lib/db'
import { parseISO, format } from 'date-fns'
import { ptBR } from 'date-fns/locale'

const client = new Anthropic()

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'add_transaction',
    description: 'Registra uma transação financeira (receita ou despesa) na conta do usuário.',
    input_schema: { type: 'object' as const, properties: { amount: { type: 'number' }, type: { type: 'string', enum: ['INCOME', 'EXPENSE'] }, description: { type: 'string' }, date: { type: 'string' }, categoryName: { type: 'string' } }, required: ['amount', 'type', 'description', 'date'] },
  },
  {
    name: 'add_goal',
    description: 'Cria uma nova meta financeira.',
    input_schema: { type: 'object' as const, properties: { name: { type: 'string' }, targetAmount: { type: 'number' }, currentAmount: { type: 'number' }, deadline: { type: 'string' }, description: { type: 'string' } }, required: ['name', 'targetAmount'] },
  },
  {
    name: 'add_bill',
    description: 'Cadastra uma conta a pagar.',
    input_schema: { type: 'object' as const, properties: { name: { type: 'string' }, amount: { type: 'number' }, dueDate: { type: 'string' }, isRecurring: { type: 'boolean' } }, required: ['name', 'amount', 'dueDate'] },
  },
  {
    name: 'get_summary',
    description: 'Retorna resumo financeiro do usuário.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'navigate',
    description: 'Sugere navegar para uma página.',
    input_schema: { type: 'object' as const, properties: { path: { type: 'string', enum: ['/dashboard','/transactions','/goals','/bills','/budget','/reports','/people','/categories','/recurring','/income','/settings'] }, reason: { type: 'string' } }, required: ['path', 'reason'] },
  },
]

async function executeTool(name: string, input: Record<string, unknown>, userId: string): Promise<string> {
  try {
    if (name === 'get_summary') {
      const now = new Date(), start = new Date(now.getFullYear(), now.getMonth(), 1), end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)
      const [income, expense, goals, bills, categories] = await Promise.all([
        db.transaction.aggregate({ where: { userId, type: 'INCOME', date: { gte: start, lte: end } }, _sum: { amount: true } }),
        db.transaction.aggregate({ where: { userId, type: 'EXPENSE', date: { gte: start, lte: end } }, _sum: { amount: true } }),
        db.goal.findMany({ where: { userId, isCompleted: false }, select: { name: true, currentAmount: true, targetAmount: true }, take: 5 }),
        db.bill.findMany({ where: { userId, isPaid: false }, select: { name: true, amount: true, dueDate: true }, take: 5, orderBy: { dueDate: 'asc' } }),
        db.category.findMany({ where: { OR: [{ isDefault: true }, { userId }] }, select: { id: true, name: true }, take: 20 }),
      ])
      const totalIncome = Number(income._sum.amount ?? 0), totalExpense = Number(expense._sum.amount ?? 0)
      return JSON.stringify({ month: format(now, 'MMMM yyyy', { locale: ptBR }), totalIncome: totalIncome.toFixed(2), totalExpense: totalExpense.toFixed(2), balance: (totalIncome - totalExpense).toFixed(2), goals: goals.map(g => ({ name: g.name, progress: `${Math.round((Number(g.currentAmount) / Number(g.targetAmount)) * 100)}%` })), pendingBills: bills.map(b => ({ name: b.name, amount: b.amount, due: format(b.dueDate, 'dd/MM', { locale: ptBR }) })), categories: categories.map(c => c.name) })
    }
    if (name === 'add_transaction') {
      const { amount, type, description, date, categoryName } = input as { amount: number; type: string; description: string; date: string; categoryName?: string }
      let categoryId: string | undefined
      if (categoryName) {
        const cat = await db.category.findFirst({ where: { name: { contains: categoryName, mode: 'insensitive' }, OR: [{ isDefault: true }, { userId }] } })
        categoryId = cat?.id
      }
      if (!categoryId) { const cat = await db.category.findFirst({ where: { OR: [{ isDefault: true }, { userId }] }, orderBy: { isDefault: 'desc' } }); categoryId = cat?.id }
      if (!categoryId) return 'Erro: nenhuma categoria disponível.'
      await db.transaction.create({ data: { amount: Math.abs(amount), type: type as 'INCOME' | 'EXPENSE', description: description ?? '', date: parseISO(date), userId, categoryId } })
      return `Transação de R$ ${Math.abs(amount).toFixed(2)} registrada.`
    }
    if (name === 'add_goal') {
      const { name, targetAmount, currentAmount = 0, deadline, description } = input as { name: string; targetAmount: number; currentAmount?: number; deadline?: string; description?: string }
      await db.goal.create({ data: { name, targetAmount, currentAmount: currentAmount ?? 0, deadline: deadline ? parseISO(deadline) : null, description: description ?? null, userId } })
      return `Meta "${name}" criada com alvo de R$ ${targetAmount.toFixed(2)}.`
    }
    if (name === 'add_bill') {
      const { name, amount, dueDate, isRecurring = false } = input as { name: string; amount: number; dueDate: string; isRecurring?: boolean }
      await db.bill.create({ data: { name, amount, dueDate: parseISO(dueDate), isRecurring, userId } })
      return `Conta "${name}" cadastrada.`
    }
    if (name === 'navigate') {
      const { path, reason } = input as { path: string; reason: string }
      return JSON.stringify({ navigate: path, reason })
    }
    return 'Ferramenta não reconhecida.'
  } catch (err) { return `Erro: ${err instanceof Error ? err.message : 'desconhecido'}` }
}

// Rate limiter
const rateLimiter = new Map<string, { count: number; resetAt: number }>()
function checkRateLimit(userId: string): boolean {
  const now = Date.now(), entry = rateLimiter.get(userId)
  if (!entry || now > entry.resetAt) { rateLimiter.set(userId, { count: 1, resetAt: now + 3600000 }); return true }
  if (entry.count >= 30) return false
  entry.count++; return true
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const session = await getSessionFromRequest(req)
  if (!session) return res.status(401).json({ error: 'Não autenticado' })

  const user = await db.user.findUnique({ where: { id: session.userId }, select: { plan: true } })
  if (!user || user.plan !== 'PRO') return res.status(403).json({ error: 'pro_required', message: 'O assistente Rook é exclusivo do plano Pro.' })
  if (!checkRateLimit(session.userId)) return res.status(429).json({ error: 'rate_limited', message: 'Limite de 30 mensagens/hora atingido.' })

  const { messages } = req.body as { messages: Anthropic.MessageParam[] }
  const truncated = messages.slice(-10)
  const safeMessages = truncated[0]?.role === 'assistant' ? truncated.slice(1) : truncated

  const today  = format(new Date(), "EEEE, dd 'de' MMMM 'de' yyyy", { locale: ptBR })
  const system = `Você é o Rook, assistente financeiro do Rook Money. Direto, amigável, especialista em finanças.\nNome: ${session.name}. Data: ${today}.\nResponda em PT-BR. Máximo 3 frases. Datas sem especificação = hoje (${format(new Date(), 'yyyy-MM-dd')}).`

  let currentMessages: Anthropic.MessageParam[] = [...safeMessages]
  let navigationSuggestion: { path: string; reason: string } | null = null

  for (let i = 0; i < 5; i++) {
    const response = await client.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, system, tools: TOOLS, messages: currentMessages })

    if (response.stop_reason === 'end_turn') {
      const text = response.content.find(b => b.type === 'text')?.text ?? ''
      return res.status(200).json({ message: text, navigate: navigationSuggestion })
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

  return res.status(200).json({ message: 'Desculpe, não consegui processar.', navigate: null })
}
