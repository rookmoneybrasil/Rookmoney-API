import Anthropic from '@anthropic-ai/sdk'
import { db } from './db'
import { checkAchievements } from './achievement-checker'
import { sendGoalCompletedEmail } from './email'
import { parseISO, format, startOfMonth, endOfMonth, addMonths } from 'date-fns'
import { randomUUID } from 'crypto'
import { ptBR } from 'date-fns/locale'

// Modelo do Rookinho. Testando Sonnet 5 (muito mais "esperto" que o Haiku 4.5
// que confundia Contas com Pessoas). Preco promocional $2/$10 por MTok ate
// 31/08/2026, depois $3/$15. Pra voltar pro Haiku: 'claude-haiku-4-5-20251001'.
export const ROOKINHO_MODEL = 'claude-sonnet-5'

// Preco por MTok (USD) — promocional ate 31/08/2026, ver comentario acima. Cache
// read custa ~10% do input normal; cache write (5min TTL) custa ~25% a mais que
// input normal na Anthropic, mas fica dentro da margem de erro pro nosso uso —
// aproximado como preco de input cheio pra simplificar.
const PRICE_PER_MTOK_INTRO = { input: 2, output: 10 }
const PRICE_PER_MTOK_STANDARD = { input: 3, output: 15 }
const PRICE_CUTOVER = new Date('2026-08-31T23:59:59Z')

function estimateCostUsd(usage: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  const price = new Date() <= PRICE_CUTOVER ? PRICE_PER_MTOK_INTRO : PRICE_PER_MTOK_STANDARD
  const cost =
    (usage.input * price.input) / 1_000_000 +
    (usage.output * price.output) / 1_000_000 +
    (usage.cacheRead * price.input * 0.1) / 1_000_000 +
    (usage.cacheWrite * price.input) / 1_000_000
  return Math.round(cost * 10_000) / 10_000
}

// ── Rate limit de rajada (anti-abuso) ───────────────────────────────────────
// PRO+ tem mensagens ILIMITADAS/mes (promessa). Isso aqui NAO e um limite mensal
// — so barra rajada absurda (spam, bot, ou usuario "brincando" com a IA), que e
// o unico jeito de o custo por usuario disparar no plano ilimitado. Invisivel pro
// uso normal. Em memoria: a API roda em processo persistente no Railway, mesmo
// padrao dos maps de historico/dedup do whatsapp.ts. Ajuste os numeros aqui.
const BURST_MAX = 30                      // mensagens
const BURST_WINDOW_MS = 60 * 60 * 1000    // por hora
const burstHits = new Map<string, number[]>()

export function checkBurstLimit(userId: string): { allowed: boolean; retryAfterMin: number } {
  const now = Date.now()
  const cutoff = now - BURST_WINDOW_MS
  const hits = (burstHits.get(userId) ?? []).filter(t => t > cutoff)
  if (hits.length >= BURST_MAX) {
    burstHits.set(userId, hits)
    const retryAfterMin = Math.max(1, Math.ceil((hits[0] + BURST_WINDOW_MS - now) / 60000))
    return { allowed: false, retryAfterMin }
  }
  hits.push(now)
  burstHits.set(userId, hits)
  return { allowed: true, retryAfterMin: 0 }
}

export const TOOLS: Anthropic.Tool[] = [
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
    description: 'Cadastra uma conta a pagar AVULSA (uma vez so) ou PARCELADA (tem numero de parcelas e um fim). Para parcelada, informe installments (total de parcelas) e alreadyPaid (parcelas ja pagas). NAO use pra conta recorrente/fixa mensal sem fim (aluguel, Netflix) — pra isso use add_recurring_bill. ATENCAO: "parcela fixa" NAO e conta fixa — se tem numero de parcelas, e PARCELADA, use esta tool aqui.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string' },
        amount: { type: 'number', description: 'Valor TOTAL em reais (sera dividido pelas parcelas se parcelado)' },
        dueDate: { type: 'string', description: 'Vencimento da primeira parcela no formato YYYY-MM-DD' },
        installments: { type: 'number', description: 'Total de parcelas (1 = avulsa, 2+ = parcelada). Notacao "parc N/T" = installments T' },
        alreadyPaid: { type: 'number', description: 'Parcelas ja pagas. Notacao "parc N/T" (a N-esima e a atual) => alreadyPaid = N-1' },
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
    description: 'Registra uma divida ou credito com uma pessoa (aba Pessoas). Suporta AVULSA (uma vez) ou PARCELADA. Para parcelada, informe installments (total de parcelas) e alreadyPaid (parcelas ja pagas) — o campo amount e o valor de CADA parcela, nao o total. NAO use pra recorrente/fixo mensal: pra isso use add_recurring_person_entry.',
    input_schema: {
      type: 'object' as const,
      properties: {
        personName: { type: 'string', description: 'Nome da pessoa (busca por nome parcial)' },
        type: { type: 'string', enum: ['THEY_OWE_ME', 'I_OWE_THEM'], description: 'THEY_OWE_ME = pessoa me deve, I_OWE_THEM = eu devo pra pessoa' },
        description: { type: 'string', description: 'Descrição (ex: almoço, empréstimo, conta de luz)' },
        amount: { type: 'number', description: 'Valor de CADA parcela em reais (se avulsa, e o valor unico)' },
        date: { type: 'string', description: 'Data (da parcela atual/primeira a lancar) no formato YYYY-MM-DD' },
        installments: { type: 'number', description: 'Total de parcelas (1 = avulsa, 2+ = parcelada). Notacao "parc N/T" = installments T' },
        alreadyPaid: { type: 'number', description: 'Parcelas ja pagas. Notacao "parc N/T" (a N-esima e a atual) => alreadyPaid = N-1' },
      },
      required: ['personName', 'type', 'description', 'amount', 'date'],
    },
  },
  {
    name: 'add_recurring_person_entry',
    description: 'Cria um modelo de divida/credito RECORRENTE com uma pessoa (aba Pessoas) — gera o lancamento automaticamente todo mes. Use quando a divida entre pessoas se repete todo mes (ex: "a Mariana me paga R$120 de ChatGPT todo mes", "pago R$200 de aluguel pro meu irmao mensalmente").',
    input_schema: {
      type: 'object' as const,
      properties: {
        personName: { type: 'string', description: 'Nome da pessoa (busca por nome parcial)' },
        type: { type: 'string', enum: ['THEY_OWE_ME', 'I_OWE_THEM'], description: 'THEY_OWE_ME = pessoa me deve todo mes, I_OWE_THEM = eu devo pra pessoa todo mes' },
        description: { type: 'string', description: 'Descrição (ex: ChatGPT, aluguel, mensalidade)' },
        amount: { type: 'number', description: 'Valor mensal em reais' },
        dayOfMonth: { type: 'number', description: 'Dia do mês em que se repete (1-31)' },
      },
      required: ['personName', 'type', 'description', 'amount'],
    },
  },
  {
    name: 'add_recurring_bill',
    description: 'Cria um modelo de conta RECORRENTE (conta fixa) que gera uma conta automaticamente todo mes, PARA SEMPRE, sem numero de parcelas e sem fim. Ex: aluguel, internet, Netflix, academia, plano de saude. NAO use se o usuario citou um numero de parcelas ou um fim (ex: "12x", "parc 3/5", "parcela fixa de 10 vezes") — isso e PARCELADA, use add_bill com installments.',
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
    name: 'delete_bill',
    description: 'Exclui uma conta a pagar (aba Contas). Use para corrigir uma conta cadastrada por engano ou no lugar errado. Busca pelo nome. Se for parcelada, remove TODAS as parcelas do grupo. Se ja estava paga, remove tambem a transacao vinculada.',
    input_schema: {
      type: 'object' as const,
      properties: {
        billName: { type: 'string', description: 'Nome (ou parte) da conta a excluir' },
      },
      required: ['billName'],
    },
  },
  {
    name: 'delete_transaction',
    description: 'Exclui uma transacao (receita ou despesa) lancada por engano. Busca pela descricao e remove a mais recente que combinar. Reseta contas/rendas que tenham gerado a transacao.',
    input_schema: {
      type: 'object' as const,
      properties: {
        description: { type: 'string', description: 'Descricao (ou parte) da transacao a excluir' },
        type: { type: 'string', enum: ['INCOME', 'EXPENSE'], description: 'Opcional: filtrar por tipo' },
      },
      required: ['description'],
    },
  },
  {
    name: 'delete_person_entry',
    description: 'Exclui um lancamento de divida/credito de uma pessoa (aba Pessoas). Busca pela pessoa e, opcionalmente, pela descricao. Remove o lancamento mais recente que combinar.',
    input_schema: {
      type: 'object' as const,
      properties: {
        personName: { type: 'string', description: 'Nome (ou parte) da pessoa' },
        description: { type: 'string', description: 'Opcional: descricao (ou parte) do lancamento a excluir' },
      },
      required: ['personName'],
    },
  },
  {
    name: 'delete_goal',
    description: 'Exclui uma meta financeira criada por engano. Busca pelo nome. Remove tambem as transacoes de aporte vinculadas.',
    input_schema: {
      type: 'object' as const,
      properties: {
        goalName: { type: 'string', description: 'Nome (ou parte) da meta a excluir' },
      },
      required: ['goalName'],
    },
  },
  {
    name: 'delete_income_source',
    description: 'Exclui uma fonte de renda cadastrada por engano. Busca pelo nome. Remove tambem as transacoes de receita geradas por ela.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Nome (ou parte) da fonte de renda a excluir' },
      },
      required: ['name'],
    },
  },
  {
    name: 'delete_recurring_bill',
    description: 'Exclui um modelo de conta recorrente (fixa) cadastrado por engano. Busca pelo nome. Remove tambem as contas pendentes ja geradas por ele.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Nome (ou parte) da conta recorrente a excluir' },
      },
      required: ['name'],
    },
  },
  {
    name: 'settle_person_entry',
    description: 'Quita uma divida/credito de uma pessoa (marca como pago/recebido na aba Pessoas). Use quando o usuario disser que alguem pagou o que devia, ou que ele pagou o que devia a alguem. Cria a transacao correspondente (receita se a pessoa pagou voce, despesa se voce pagou a pessoa).',
    input_schema: {
      type: 'object' as const,
      properties: {
        personName: { type: 'string', description: 'Nome (ou parte) da pessoa' },
        description: { type: 'string', description: 'Opcional: descricao (ou parte) do lancamento a quitar' },
      },
      required: ['personName'],
    },
  },
  {
    name: 'update_bill',
    description: 'Edita uma conta a pagar existente (nome, valor, vencimento ou categoria). Use para corrigir dados de uma conta ja cadastrada. So informe os campos que mudam.',
    input_schema: {
      type: 'object' as const,
      properties: {
        billName: { type: 'string', description: 'Nome (ou parte) da conta a editar' },
        newName: { type: 'string', description: 'Novo nome' },
        amount: { type: 'number', description: 'Novo valor em reais' },
        dueDate: { type: 'string', description: 'Novo vencimento no formato YYYY-MM-DD' },
        categoryName: { type: 'string', description: 'Nova categoria' },
      },
      required: ['billName'],
    },
  },
  {
    name: 'update_transaction',
    description: 'Edita uma transacao existente (valor, tipo, descricao, data ou categoria). Use para corrigir uma transacao ja lancada. So informe os campos que mudam.',
    input_schema: {
      type: 'object' as const,
      properties: {
        description: { type: 'string', description: 'Descricao (ou parte) da transacao a editar' },
        amount: { type: 'number', description: 'Novo valor em reais' },
        newDescription: { type: 'string', description: 'Nova descricao' },
        date: { type: 'string', description: 'Nova data no formato YYYY-MM-DD' },
        categoryName: { type: 'string', description: 'Nova categoria' },
      },
      required: ['description'],
    },
  },
  {
    name: 'update_person_entry',
    description: 'Edita um lancamento de divida/credito de uma pessoa (valor, descricao, tipo ou data). Use para corrigir um lancamento ja feito na aba Pessoas. So informe os campos que mudam.',
    input_schema: {
      type: 'object' as const,
      properties: {
        personName: { type: 'string', description: 'Nome (ou parte) da pessoa' },
        description: { type: 'string', description: 'Descricao (ou parte) do lancamento a editar' },
        amount: { type: 'number', description: 'Novo valor em reais' },
        newDescription: { type: 'string', description: 'Nova descricao' },
        type: { type: 'string', enum: ['THEY_OWE_ME', 'I_OWE_THEM'], description: 'Novo tipo' },
        date: { type: 'string', description: 'Nova data no formato YYYY-MM-DD' },
      },
      required: ['personName'],
    },
  },
  {
    name: 'unpay_bill',
    description: 'Desmarca uma conta como paga (volta a pendente) e remove a transacao de despesa que foi criada quando ela foi paga. Use quando o usuario disser que marcou uma conta como paga por engano.',
    input_schema: {
      type: 'object' as const,
      properties: {
        billName: { type: 'string', description: 'Nome (ou parte) da conta paga a desmarcar' },
      },
      required: ['billName'],
    },
  },
  {
    name: 'withdraw_from_goal',
    description: 'Retira dinheiro de uma meta (reduz o valor guardado). Use quando o usuario disser que tirou/sacou dinheiro de uma meta. Remove as transacoes de aporte correspondentes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        goalName: { type: 'string', description: 'Nome (ou parte) da meta' },
        amount: { type: 'number', description: 'Valor a retirar em reais' },
      },
      required: ['goalName', 'amount'],
    },
  },
  {
    name: 'set_budget',
    description: 'Define ou atualiza o orcamento planejado de uma categoria para o mes atual. Use quando o usuario quiser planejar quanto pretende gastar numa categoria.',
    input_schema: {
      type: 'object' as const,
      properties: {
        categoryName: { type: 'string', description: 'Nome da categoria (ex: Alimentacao, Transporte)' },
        amount: { type: 'number', description: 'Valor planejado em reais para o mes' },
      },
      required: ['categoryName', 'amount'],
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

export function money(v: unknown): string {
  return `R$ ${Number(v ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function fmtDate(d: Date): string {
  return format(d, 'dd/MM/yyyy', { locale: ptBR })
}

/** Converte "YYYY-MM-DD" pra Date ao MEIO-DIA UTC.
 *
 *  NAO use parseISO() pra esses campos: ele devolve meia-noite LOCAL, que no
 *  Railway (UTC) vira meia-noite UTC — e o usuario no Brasil (UTC-3) enxerga o
 *  DIA ANTERIOR ("vence dia 20" aparecia como 19/07). Meio-dia UTC cai no mesmo
 *  dia do calendario de UTC-11 a UTC+11. Mesma convencao dos endpoints REST
 *  (Date.UTC(y, m-1, d, 12, 0, 0)) — ver CLAUDE.md. */
function parseDateUTC(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  if (!y || !m || !d) return parseISO(s) // string com hora: deixa o parseISO resolver
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
}

/** Paga uma conta pelo ID: marca paga E cria a Transaction de despesa, com o
 *  paidTransactionId ligando as duas — exatamente o que o endpoint REST
 *  (POST /bills/:id?action=pay) faz.
 *
 *  Existe porque a tool pay_bill so marcava isPaid e NAO criava a transacao: quem
 *  pagava conta pelo Rookinho ficava com o gasto fora do resumo/dashboard, e o
 *  paidTransactionId null quebrava o cascade delete (apagar a transacao deveria
 *  despagar a conta). Usado pela tool pay_bill e pelo menu do WhatsApp. */
export async function payBillById(userId: string, billId: string): Promise<string> {
  const bill = await db.bill.findFirst({ where: { id: billId, userId } })
  if (!bill) return 'Nao encontrei essa conta.'
  if (bill.isPaid) return `A conta "${bill.name}" ja estava paga.`

  const categoryId = bill.categoryId ?? (await findCategory(userId)) ?? null
  if (!categoryId) return 'Erro: nenhuma categoria disponivel pra registrar a despesa.'

  const tx = await db.transaction.create({
    data: { amount: bill.amount, type: 'EXPENSE', description: bill.name, date: new Date(), userId, categoryId },
  })
  await db.bill.update({
    where: { id: bill.id },
    data: { isPaid: true, paidAt: new Date(), paidTransactionId: tx.id },
  })
  checkAchievements(db, userId, 'pay-bill', { billId: bill.id }).catch(() => {})
  return `Conta "${bill.name}" de ${money(bill.amount)} marcada como paga! 💰`
}

export async function executeTool(name: string, input: Record<string, unknown>, userId: string): Promise<string> {
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
        db.$queryRawUnsafe<{ month: string; type: string; total: number }[]>(
          `SELECT to_char(date, 'YYYY-MM') as month, type, SUM(amount)::float as total
           FROM "Transaction" WHERE "userId" = $1 AND date >= $2
           GROUP BY month, type ORDER BY month`,
          userId, threeMonthsAgo
        ).catch(() => []),
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
      await db.transaction.create({ data: { amount: Math.abs(amount), type: type as 'INCOME' | 'EXPENSE', description: description ?? '', date: parseDateUTC(date), userId, categoryId } })
      checkAchievements(db, userId, 'create-transaction').catch(() => {})
      return `Transação "${description}" de ${money(Math.abs(amount))} registrada com sucesso.`
    }

    if (name === 'add_goal') {
      const { name: gName, targetAmount, currentAmount = 0, deadline, description } = input as { name: string; targetAmount: number; currentAmount?: number; deadline?: string; description?: string }
      await db.goal.create({ data: { name: gName, targetAmount, currentAmount: currentAmount ?? 0, deadline: deadline ? parseDateUTC(deadline) : null, description: description ?? null, userId } })
      checkAchievements(db, userId, 'create-goal').catch(() => {})
      return `Meta "${gName}" criada com alvo de ${money(targetAmount)}.`
    }

    if (name === 'add_bill') {
      // isRecurring saiu do schema da tool de proposito: marcava so uma flag numa
      // conta avulsa, NAO criava o template RecurringBill — o modelo usava achando
      // que fazia conta fixa. Recorrente = add_recurring_bill, sempre.
      const { name: bName, amount, dueDate, installments = 1, alreadyPaid = 0, categoryName } = input as { name: string; amount: number; dueDate: string; installments?: number; alreadyPaid?: number; categoryName?: string }
      const categoryId = categoryName ? (await findCategory(userId, categoryName)) : undefined
      const baseDate = parseDateUTC(dueDate)
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
        checkAchievements(db, userId, 'create-bill').catch(() => {})
        return `Conta "${bName}" parcelada em ${numTotal}x de ${money(amount / numToCreate)} cadastrada${numAlreadyPaid > 0 ? ` (${numAlreadyPaid} parcelas ja pagas, ${numToCreate} restantes)` : ''}. Primeira parcela em ${fmtDate(baseDate)}.`
      }

      await db.bill.create({ data: { name: bName, amount, dueDate: baseDate, isRecurring: false, userId, ...(categoryId ? { categoryId } : {}) } })
      checkAchievements(db, userId, 'create-bill').catch(() => {})
      return `Conta "${bName}" de ${money(amount)} cadastrada para ${fmtDate(baseDate)}.`
    }

    if (name === 'pay_bill') {
      const { billName } = input as { billName: string }
      const bill = await db.bill.findFirst({
        where: { userId, isPaid: false, name: { contains: billName, mode: 'insensitive' } },
        orderBy: { dueDate: 'asc' },
      })
      if (!bill) return `Não encontrei conta pendente com nome "${billName}".`
      return payBillById(userId, bill.id)
    }

    if (name === 'contribute_to_goal') {
      const { goalName, amount } = input as { goalName: string; amount: number }
      const goal = await db.goal.findFirst({
        where: { userId, isCompleted: false, name: { contains: goalName, mode: 'insensitive' } },
      })
      if (!goal) return `Não encontrei meta ativa com nome "${goalName}".`
      const amt = Math.abs(amount)
      const newAmount = Number(goal.currentAmount) + amt
      const isCompleted = newAmount >= Number(goal.targetAmount)

      // Mesma escolha de categoria do endpoint REST: prefere "Poupanca", senao a padrao.
      const cat = (await db.category.findFirst({
        where: { name: { contains: 'Poupan', mode: 'insensitive' }, OR: [{ isDefault: true }, { userId }] },
      })) ?? (await db.category.findFirst({
        where: { OR: [{ isDefault: true }, { userId }] }, orderBy: { isDefault: 'desc' },
      }))
      if (!cat) return 'Erro: nenhuma categoria disponivel pra registrar o aporte.'

      // A Transaction "Aporte — X" e obrigatoria: sem ela o aporte nao entra no
      // resumo/dashboard, e withdraw_from_goal/delete_goal (que procuram por essa
      // descricao pra estornar) nao acham nada. Igual ao POST /goals/:id?action=contribute.
      await db.$transaction([
        db.goal.update({ where: { id: goal.id }, data: { currentAmount: newAmount, isCompleted, completedAt: isCompleted ? new Date() : null } }),
        db.transaction.create({ data: { amount: amt, type: 'EXPENSE', description: `Aporte — ${goal.name}`, date: new Date(), userId, categoryId: cat.id } }),
        db.goalContribution.create({ data: { goalId: goal.id, amount: amt } }),
      ])
      checkAchievements(db, userId, 'contribute-goal').catch(() => {})
      if (isCompleted) {
        const u = await db.user.findUnique({ where: { id: userId }, select: { email: true, name: true } })
        if (u) sendGoalCompletedEmail(u.email, u.name, goal.name, Number(goal.targetAmount)).catch(() => {})
      }
      if (isCompleted) return `Contribuição de ${money(amt)} adicionada! Meta "${goal.name}" foi COMPLETADA! Parabéns! 🎉`
      return `Contribuição de ${money(amt)} adicionada à meta "${goal.name}". Progresso: ${money(newAmount)} de ${money(goal.targetAmount)} (${Math.round((newAmount / Number(goal.targetAmount)) * 100)}%).`
    }

    if (name === 'add_income_source') {
      const { name: sName, amount, type: sType = 'OTHER', isRecurring = true, dayOfMonth, categoryName } = input as { name: string; amount: number; type?: string; isRecurring?: boolean; dayOfMonth?: number; categoryName?: string }
      const categoryId = categoryName ? (await findCategory(userId, categoryName)) : undefined
      await db.incomeSource.create({
        data: { name: sName, amount: Math.abs(amount), type: sType as 'EMPLOYMENT' | 'FREELANCE' | 'RENTAL' | 'OTHER', isRecurring, dayOfMonth: dayOfMonth ?? null, userId, ...(categoryId ? { categoryId } : {}) },
      })
      checkAchievements(db, userId, 'create-income').catch(() => {})
      return `Renda "${sName}" de ${money(amount)}/mês cadastrada${dayOfMonth ? ` (dia ${dayOfMonth})` : ''}.`
    }

    if (name === 'add_person') {
      const { name: pName, notes } = input as { name: string; notes?: string }
      const existing = await db.person.findFirst({ where: { userId, name: { contains: pName, mode: 'insensitive' } } })
      if (existing) return `A pessoa "${existing.name}" já está cadastrada.`
      await db.person.create({ data: { name: pName, notes: notes ?? null, userId } })
      checkAchievements(db, userId, 'create-person').catch(() => {})
      return `Pessoa "${pName}" cadastrada.`
    }

    if (name === 'add_person_entry') {
      const { personName, type: eType, description: desc, amount, date, installments = 1, alreadyPaid = 0 } = input as { personName: string; type: string; description: string; amount: number; date: string; installments?: number; alreadyPaid?: number }
      let person = await db.person.findFirst({ where: { userId, name: { contains: personName, mode: 'insensitive' } } })
      if (!person) {
        person = await db.person.create({ data: { name: personName, userId } })
      }
      const pType = eType as 'THEY_OWE_ME' | 'I_OWE_THEM'
      const perInstallment = Math.abs(amount)
      const baseDate = parseDateUTC(date)
      const numTotal = Math.max(1, Math.round(installments))
      const label = pType === 'THEY_OWE_ME' ? `${person.name} te deve` : `Voce deve pra ${person.name}`

      // Parcelada: cria uma PersonEntry por parcela restante, com grupo (mesma
      // logica do endpoint people/[id]?action=entry — amount e POR PARCELA).
      if (numTotal > 1) {
        const numAlreadyPaid = Math.max(0, Math.min(Math.round(alreadyPaid), numTotal - 1))
        const remaining = numTotal - numAlreadyPaid
        const groupId = randomUUID()
        await db.personEntry.createMany({
          data: Array.from({ length: remaining }, (_, i) => ({
            type: pType, description: desc, amount: perInstallment,
            date: addMonths(baseDate, i),
            personId: person!.id, userId,
            installmentTotal: numTotal,
            installmentCurrent: numAlreadyPaid + i + 1,
            installmentGroupId: groupId,
          })),
        })
        checkAchievements(db, userId, 'create-person-entry').catch(() => {})
        return `Registrado: ${label} ${remaining}x de ${money(perInstallment)} (${desc})${numAlreadyPaid > 0 ? ` — ${numAlreadyPaid} ja pagas, ${remaining} restantes` : ''}.`
      }

      // Avulsa
      await db.personEntry.create({
        data: { type: pType, description: desc, amount: perInstallment, date: baseDate, personId: person.id, userId },
      })
      checkAchievements(db, userId, 'create-person-entry').catch(() => {})
      return `Registrado: ${label} ${money(perInstallment)} (${desc}).`
    }

    if (name === 'add_recurring_person_entry') {
      const { personName, type: eType, description: desc, amount, dayOfMonth = 1 } = input as { personName: string; type: string; description: string; amount: number; dayOfMonth?: number }
      let person = await db.person.findFirst({ where: { userId, name: { contains: personName, mode: 'insensitive' } } })
      if (!person) {
        person = await db.person.create({ data: { name: personName, userId } })
      }
      const pType = eType as 'THEY_OWE_ME' | 'I_OWE_THEM'
      const day = Math.min(Math.max(Math.round(dayOfMonth), 1), 31)
      await db.personEntryRecurring.create({
        data: { type: pType, description: desc, amount: Math.abs(amount), dayOfMonth: day, personId: person.id, userId },
      })
      const label = pType === 'THEY_OWE_ME' ? `${person.name} te deve` : `Voce deve pra ${person.name}`
      return `Recorrente cadastrado: ${label} ${money(amount)}/mês (dia ${day}) — ${desc}. Vai gerar automaticamente todo mês.`
    }

    if (name === 'add_recurring_bill') {
      const { name: rbName, amount, dayOfMonth, categoryName } = input as { name: string; amount: number; dayOfMonth: number; categoryName?: string }
      const categoryId = categoryName ? (await findCategory(userId, categoryName)) : undefined
      await db.recurringBill.create({
        data: { name: rbName, amount: Math.abs(amount), dayOfMonth: Math.min(Math.max(dayOfMonth, 1), 28), userId, ...(categoryId ? { categoryId } : {}) },
      })
      checkAchievements(db, userId, 'create-recurring-bill').catch(() => {})
      return `Conta recorrente "${rbName}" de ${money(amount)}/mês (dia ${dayOfMonth}) cadastrada. Vai gerar contas automaticamente todo mês.`
    }

    if (name === 'delete_bill') {
      const { billName } = input as { billName: string }
      const bill = await db.bill.findFirst({
        where: { userId, name: { contains: billName, mode: 'insensitive' } },
        orderBy: { createdAt: 'desc' },
      })
      if (!bill) return `Nao encontrei conta com nome "${billName}".`

      // Parcelada → apaga todas as parcelas do grupo + transacoes vinculadas
      if (bill.installmentGroupId) {
        const group = await db.bill.findMany({
          where: { installmentGroupId: bill.installmentGroupId, userId },
          select: { paidTransactionId: true },
        })
        const txIds = group.map(b => b.paidTransactionId).filter(Boolean) as string[]
        await db.bill.deleteMany({ where: { installmentGroupId: bill.installmentGroupId, userId } })
        if (txIds.length) await db.transaction.deleteMany({ where: { id: { in: txIds }, userId } })
        return `Conta parcelada "${bill.name}" excluida (todas as parcelas).`
      }

      if (bill.paidTransactionId) {
        await db.transaction.deleteMany({ where: { id: bill.paidTransactionId, userId } })
      }
      await db.bill.deleteMany({ where: { id: bill.id, userId } })
      // Se veio de um modelo recorrente, marca o mes como ja processado (nao regenera)
      if (bill.recurringBillId) {
        await db.recurringBill.updateMany({
          where: { id: bill.recurringBillId, userId },
          data: { lastAutoMonth: format(now, 'yyyy-MM') },
        })
      }
      return `Conta "${bill.name}" de ${money(bill.amount)} excluida.`
    }

    if (name === 'delete_transaction') {
      const { description: desc, type: tType } = input as { description: string; type?: string }
      const tx = await db.transaction.findFirst({
        where: { userId, description: { contains: desc, mode: 'insensitive' }, ...(tType ? { type: tType as 'INCOME' | 'EXPENSE' } : {}) },
        orderBy: { createdAt: 'desc' },
      })
      if (!tx) return `Nao encontrei transacao com descricao "${desc}".`

      // Reseta conta paga por essa transacao
      await db.bill.updateMany({
        where: { paidTransactionId: tx.id, userId },
        data: { isPaid: false, paidAt: null, paidTransactionId: null },
      })
      // Reseta renda/recorrente se foi gerada este mes
      const txDate = new Date(tx.date)
      if (txDate.getFullYear() === now.getFullYear() && txDate.getMonth() === now.getMonth() && tx.description) {
        const yearMonth = format(now, 'yyyy-MM')
        if (tx.type === 'INCOME') {
          await db.incomeSource.updateMany({
            where: { userId, name: tx.description, isRecurring: true, lastAutoPayMonth: yearMonth },
            data: { lastAutoPayMonth: null },
          })
        }
        await db.recurringTransaction.updateMany({
          where: { userId, name: tx.description, type: tx.type, lastAutoMonth: yearMonth },
          data: { lastAutoMonth: null },
        })
      }
      await db.transaction.deleteMany({ where: { id: tx.id, userId } })
      return `Transacao "${tx.description ?? '(sem descricao)'}" de ${money(tx.amount)} excluida.`
    }

    if (name === 'delete_person_entry') {
      const { personName, description: desc } = input as { personName: string; description?: string }
      const person = await db.person.findFirst({ where: { userId, name: { contains: personName, mode: 'insensitive' } } })
      if (!person) return `Nao encontrei a pessoa "${personName}".`
      const entry = await db.personEntry.findFirst({
        where: { userId, personId: person.id, ...(desc ? { description: { contains: desc, mode: 'insensitive' } } : {}) },
        orderBy: { createdAt: 'desc' },
      })
      if (!entry) return `Nao encontrei lancamento${desc ? ` "${desc}"` : ''} para "${person.name}".`
      await db.personEntry.deleteMany({ where: { id: entry.id, userId } })
      if (entry.settledTransactionId) {
        await db.transaction.deleteMany({ where: { id: entry.settledTransactionId, userId } })
      }
      return `Lancamento "${entry.description}" de ${money(entry.amount)} de "${person.name}" excluido.`
    }

    if (name === 'delete_goal') {
      const { goalName } = input as { goalName: string }
      const goal = await db.goal.findFirst({ where: { userId, name: { contains: goalName, mode: 'insensitive' } }, orderBy: { createdAt: 'desc' } })
      if (!goal) return `Nao encontrei meta com nome "${goalName}".`
      await db.transaction.deleteMany({ where: { userId, description: `Aporte — ${goal.name}` } })
      await db.goal.deleteMany({ where: { id: goal.id, userId } })
      return `Meta "${goal.name}" excluida.`
    }

    if (name === 'delete_income_source') {
      const { name: sName } = input as { name: string }
      const src = await db.incomeSource.findFirst({ where: { userId, name: { contains: sName, mode: 'insensitive' } }, orderBy: { createdAt: 'desc' } })
      if (!src) return `Nao encontrei fonte de renda com nome "${sName}".`
      await db.transaction.deleteMany({ where: { userId, type: 'INCOME', description: src.name } })
      await db.incomeSource.deleteMany({ where: { id: src.id, userId } })
      return `Fonte de renda "${src.name}" excluida.`
    }

    if (name === 'delete_recurring_bill') {
      const { name: rbName } = input as { name: string }
      const template = await db.recurringBill.findFirst({ where: { userId, name: { contains: rbName, mode: 'insensitive' } }, orderBy: { createdAt: 'desc' } })
      if (!template) return `Nao encontrei conta recorrente com nome "${rbName}".`
      await db.bill.deleteMany({ where: { recurringBillId: template.id, userId, isPaid: false } })
      await db.recurringBill.deleteMany({ where: { id: template.id, userId } })
      return `Conta recorrente "${template.name}" excluida.`
    }

    if (name === 'settle_person_entry') {
      const { personName, description: desc } = input as { personName: string; description?: string }
      const person = await db.person.findFirst({ where: { userId, name: { contains: personName, mode: 'insensitive' } } })
      if (!person) return `Nao encontrei a pessoa "${personName}".`
      const entry = await db.personEntry.findFirst({
        where: { userId, personId: person.id, isSettled: false, ...(desc ? { description: { contains: desc, mode: 'insensitive' } } : {}) },
        orderBy: { date: 'asc' },
      })
      if (!entry) return `Nao encontrei lancamento pendente${desc ? ` "${desc}"` : ''} para "${person.name}".`
      const txType = entry.type === 'I_OWE_THEM' ? 'EXPENSE' : 'INCOME'
      const categoryId = entry.categoryId ?? (await findCategory(userId))
      if (!categoryId) return 'Erro: nenhuma categoria disponivel.'
      const tx = await db.transaction.create({
        data: { amount: entry.amount, type: txType, description: `${entry.description} (${person.name})`, date: new Date(), userId, categoryId },
      })
      await db.personEntry.update({ where: { id: entry.id }, data: { isSettled: true, settledAt: new Date(), settledTransactionId: tx.id } })
      const label = entry.type === 'THEY_OWE_ME' ? `${person.name} te pagou` : `Voce pagou ${person.name}`
      return `Quitado: ${label} ${money(entry.amount)} (${entry.description}).`
    }

    if (name === 'update_bill') {
      const { billName, newName, amount, dueDate, categoryName } = input as { billName: string; newName?: string; amount?: number; dueDate?: string; categoryName?: string }
      const bill = await db.bill.findFirst({ where: { userId, name: { contains: billName, mode: 'insensitive' } }, orderBy: { createdAt: 'desc' } })
      if (!bill) return `Nao encontrei conta com nome "${billName}".`
      const categoryId = categoryName ? (await findCategory(userId, categoryName)) : undefined

      // Parcelada: nome/valor/categoria valem pro GRUPO inteiro, igual ao
      // PATCH /bills/group/:groupId. Sem isso, "muda o valor do sofa" alterava
      // so 1 das 10 parcelas e o usuario nem percebia.
      if (bill.installmentGroupId && (newName !== undefined || amount !== undefined || categoryId)) {
        await db.bill.updateMany({
          where: { installmentGroupId: bill.installmentGroupId, userId, isPaid: false },
          data: {
            ...(newName !== undefined && { name: newName }),
            ...(amount !== undefined && { amount: Math.abs(amount) }),
            ...(categoryId ? { categoryId } : {}),
          },
        })
        // Nome tambem nas ja pagas, pra nao ficar historico com dois nomes
        if (newName !== undefined) {
          await db.bill.updateMany({
            where: { installmentGroupId: bill.installmentGroupId, userId, isPaid: true },
            data: { name: newName },
          })
        }
        // Data e do lancamento especifico, nao do grupo
        if (dueDate !== undefined) {
          await db.bill.update({ where: { id: bill.id }, data: { dueDate: parseDateUTC(dueDate) } })
        }
        return `Conta parcelada "${newName ?? bill.name}" atualizada (todas as parcelas pendentes).`
      }

      await db.bill.update({
        where: { id: bill.id },
        data: {
          ...(newName !== undefined && { name: newName }),
          ...(amount !== undefined && { amount: Math.abs(amount) }),
          ...(dueDate !== undefined && { dueDate: parseDateUTC(dueDate) }),
          ...(categoryId ? { categoryId } : {}),
        },
      })
      return `Conta "${newName ?? bill.name}" atualizada.`
    }

    if (name === 'update_transaction') {
      const { description: desc, amount, newDescription, date, categoryName } = input as { description: string; amount?: number; newDescription?: string; date?: string; categoryName?: string }
      const tx = await db.transaction.findFirst({ where: { userId, description: { contains: desc, mode: 'insensitive' } }, orderBy: { createdAt: 'desc' } })
      if (!tx) return `Nao encontrei transacao com descricao "${desc}".`
      const categoryId = categoryName ? (await findCategory(userId, categoryName)) : undefined
      await db.transaction.update({
        where: { id: tx.id },
        data: {
          ...(amount !== undefined && { amount: Math.abs(amount) }),
          ...(newDescription !== undefined && { description: newDescription }),
          ...(date !== undefined && { date: parseDateUTC(date) }),
          ...(categoryId ? { categoryId } : {}),
        },
      })
      return `Transacao "${newDescription ?? tx.description ?? '(sem descricao)'}" atualizada.`
    }

    if (name === 'update_person_entry') {
      const { personName, description: desc, amount, newDescription, type: eType, date } = input as { personName: string; description?: string; amount?: number; newDescription?: string; type?: string; date?: string }
      const person = await db.person.findFirst({ where: { userId, name: { contains: personName, mode: 'insensitive' } } })
      if (!person) return `Nao encontrei a pessoa "${personName}".`
      const entry = await db.personEntry.findFirst({
        where: { userId, personId: person.id, ...(desc ? { description: { contains: desc, mode: 'insensitive' } } : {}) },
        orderBy: { createdAt: 'desc' },
      })
      if (!entry) return `Nao encontrei lancamento${desc ? ` "${desc}"` : ''} para "${person.name}".`

      // Parcelada: descricao/valor/tipo valem pro GRUPO (parcelas pendentes),
      // igual ao PATCH /people/entries/:id com applyToGroup.
      if (entry.installmentGroupId && (amount !== undefined || newDescription !== undefined || eType !== undefined)) {
        await db.personEntry.updateMany({
          where: { installmentGroupId: entry.installmentGroupId, userId, isSettled: false },
          data: {
            ...(amount !== undefined && { amount: Math.abs(amount) }),
            ...(newDescription !== undefined && { description: newDescription }),
            ...(eType !== undefined && { type: eType as 'THEY_OWE_ME' | 'I_OWE_THEM' }),
          },
        })
        if (date !== undefined) {
          await db.personEntry.update({ where: { id: entry.id }, data: { date: parseDateUTC(date) } })
        }
        return `Lancamento parcelado de "${person.name}" atualizado (todas as parcelas pendentes).`
      }

      await db.personEntry.update({
        where: { id: entry.id },
        data: {
          ...(amount !== undefined && { amount: Math.abs(amount) }),
          ...(newDescription !== undefined && { description: newDescription }),
          ...(eType !== undefined && { type: eType as 'THEY_OWE_ME' | 'I_OWE_THEM' }),
          ...(date !== undefined && { date: parseDateUTC(date) }),
        },
      })
      return `Lancamento de "${person.name}" atualizado.`
    }

    if (name === 'unpay_bill') {
      const { billName } = input as { billName: string }
      const bill = await db.bill.findFirst({ where: { userId, isPaid: true, name: { contains: billName, mode: 'insensitive' } }, orderBy: { paidAt: 'desc' } })
      if (!bill) return `Nao encontrei conta paga com nome "${billName}".`
      if (bill.paidTransactionId) {
        await db.transaction.deleteMany({ where: { id: bill.paidTransactionId, userId } })
      }
      await db.bill.update({ where: { id: bill.id }, data: { isPaid: false, paidAt: null, paidTransactionId: null } })
      return `Conta "${bill.name}" voltou para pendente.`
    }

    if (name === 'withdraw_from_goal') {
      const { goalName, amount } = input as { goalName: string; amount: number }
      const goal = await db.goal.findFirst({ where: { userId, name: { contains: goalName, mode: 'insensitive' } } })
      if (!goal) return `Nao encontrei meta com nome "${goalName}".`
      const amt = Math.abs(amount)
      const newAmount = Math.max(0, Number(goal.currentAmount) - amt)
      const aportes = await db.transaction.findMany({
        where: { userId, type: 'EXPENSE', description: `Aporte — ${goal.name}` },
        orderBy: { date: 'desc' },
      })
      let remaining = amt
      const toDelete: string[] = []
      let toShrink: { id: string; newAmount: number } | null = null
      for (const tx of aportes) {
        if (remaining <= 0) break
        const txAmt = Number(tx.amount)
        if (txAmt <= remaining) { toDelete.push(tx.id); remaining -= txAmt }
        else { toShrink = { id: tx.id, newAmount: txAmt - remaining }; remaining = 0 }
      }
      await db.$transaction([
        db.goal.update({ where: { id: goal.id }, data: { currentAmount: newAmount, isCompleted: false, completedAt: null } }),
        ...(toDelete.length ? [db.transaction.deleteMany({ where: { id: { in: toDelete }, userId } })] : []),
        ...(toShrink ? [db.transaction.update({ where: { id: toShrink.id }, data: { amount: toShrink.newAmount } })] : []),
        db.goalContribution.create({ data: { goalId: goal.id, amount: -amt, note: 'Retirada' } }),
      ])
      return `Retirada de ${money(amt)} da meta "${goal.name}". Saldo atual: ${money(newAmount)}.`
    }

    if (name === 'set_budget') {
      const { categoryName, amount } = input as { categoryName: string; amount: number }
      const categoryId = await findCategory(userId, categoryName)
      if (!categoryId) return `Nao encontrei a categoria "${categoryName}".`
      const month = format(now, 'yyyy-MM')
      const cat = await db.category.findUnique({ where: { id: categoryId }, select: { name: true } })
      await db.budget.upsert({
        where: { userId_categoryId_month: { userId, categoryId, month } },
        update: { amount: Math.abs(amount) },
        create: { userId, categoryId, month, amount: Math.abs(amount) },
      })
      return `Orcamento de ${money(amount)} definido para "${cat?.name ?? categoryName}" neste mes.`
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

export function buildSystemPrompt(userName: string): string {
  const today = format(new Date(), "EEEE, dd 'de' MMMM 'de' yyyy", { locale: ptBR })
  const todayISO = format(new Date(), 'yyyy-MM-dd')

  return `Voce e o Rookinho, o touro azul mascote do Rook Money — assistente financeiro com personalidade.
Usuario: ${userName}. Hoje: ${today} (${todayISO}).

PERSONALIDADE E FOCO (muito importante):
Voce e um ASSISTENTE FINANCEIRO com bom humor — NAO um chatbot de bate-papo. Seu trabalho e organizar as financas do usuario (contas, transacoes, metas, pessoas, orcamento, rendas, analise), mas com a personalidade debochada e simpatica que da carisma ao Rook Money.
Solte piadinhas leves e comentarios espertos sobre os GASTOS, contas e conquistas do usuario — isso e bem-vindo e faz parte do seu jeito. Zoe com carinho, comemore as vitorias. Seu tom:
- Gasto alto: "Eita, R$ 500 em iFood? Ta alimentando o bairro inteiro, hein — registrei aqui."
- Economizou: "Opa, guardando dinheiro? To ate emocionado. Ta indo bem!"
- Meta batida: "CONSEGUIU! Orgulhoso de voce — comemora, mas sem gastar tudo de novo ne."
- Conta vencida: "Conta vencida de novo? Assim voce me deixa triste, paga logo essa."
MODERACAO (o equilibrio importa): o humor TEMPERA, nao domina. Uma piadinha por resposta ja basta — nao force graca em toda linha, nao enrole, nao vira comediante. Resposta curta com um toque de humor > textao engracadinho. E o humor e SEMPRE sobre as financas do usuario, nunca vira papo aleatorio.
NUNCA use girias como "mano", "ta ligado", "parça", "bro", "meu chapa", "firmeza".

ESCOPO — voce SO trata de financas:
Se o usuario tentar bater papo, pedir piada/historia/poema/jogo, perguntar sobre assunto fora de financas (clima, futebol, receita, programacao, conselho de vida, "quem e voce", etc.) ou tentar "brincar" com voce, RECUSE educadamente em UMA frase curta e traga de volta pro foco. Ex: "Haha, eu cuido so das suas financas — quer que eu organize alguma conta ou gasto?". Nao entre na brincadeira, nao gere o conteudo pedido fora de escopo, nao escreva textao. Uma frase e volta ao trabalho.

FORMATO DE RESPOSTA (obrigatorio):
- SEM markdown pesado (nada de asteriscos duplos, hashtags, blocos de codigo)
- Use quebras de linha para separar ideias diferentes
- Quando listar itens (contas, transacoes, dicas), use bullets com "• " no inicio de cada linha
- Maximo 1-2 emojis por resposta, so se combinar
- NUNCA use emoji de vaca/boi/touro (🐂 🐮 🐄 🐃) — fica cafona e nem parece o Rookinho, que e um touro AZUL. Prefira emojis com energia: 💰 💸 ⚡ ✅ 🎯 💪 👊 🔥 ✨ 📊 🚀 👋
- Valores sempre como R$ 1.234,56
- Datas como 22/06/2026
Exemplo de formato bom:
Seu resumo de junho:
• Receita: R$ 9.500,00
• Despesas: R$ 6.792,01
• Saldo: R$ 2.707,99

Voce tem 2 contas vencidas, recomendo quitar logo!

COMPORTAMENTO:
- Portugues brasileiro, tom amigavel, bem-humorado e direto
- Respostas CURTAS por padrao (1 a 3 frases), mas com aquele toque de humor. So use mais espaco quando for uma analise financeira que o usuario pediu
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

CONTAS (a pagar) vs PESSOAS (dividas) — leia com atencao, e onde mais se erra:
Existem DUAS coisas diferentes que a palavra "conta" pode significar. NUNCA confunda:
- add_bill / add_recurring_bill (aba CONTAS): boletos, faturas, mensalidades, parcelas, despesas que VOCE (usuario) tem que pagar a uma empresa/servico. Ex: "conta de luz", "fatura do cartao", "aluguel", "Netflix", "parcela do celular".
- add_person_entry (aba PESSOAS): dividas e emprestimos entre o usuario e OUTRA PESSOA (alguem com nome). Ex: "o Joao me deve 50", "devo 200 pra Maria", "emprestei pro meu irmao", "paguei a conta do rodizio pra galera e cada um me deve".
Regra pratica: se a mensagem cita o NOME de uma pessoa como quem deve ou a quem se deve, ou fala de emprestimo/divida entre pessoas, e SEMPRE add_person_entry (Pessoas) — NUNCA add_bill.
Se o usuario disser explicitamente "coloca em Pessoas", "lanca em Pessoas" ou "isso e divida de pessoa", use add_person_entry mesmo que ele tenha usado a palavra "conta".
Na duvida entre os dois, PERGUNTE antes de criar: "Isso e uma conta que voce paga (aba Contas) ou uma divida com alguem (aba Pessoas)?".

DENTRO DE CONTAS — diferencie avulsa, parcelada e recorrente (e onde mais se erra depois):
A pergunta que decide tudo: TEM FIM ou NAO TEM FIM?
- AVULSA (uma vez so, nao repete): add_bill sem installments. Ex: "boleto do IPVA dia 10", "exame R$200".
- PARCELADA (TEM FIM — existe um numero de parcelas): add_bill COM installments e alreadyPaid. Ex: "celular em 12x", "sofa parc 3/5", "curso em 10 vezes".
- RECORRENTE / CONTA FIXA (NAO TEM FIM — repete todo mes pra sempre): add_recurring_bill. Ex: "aluguel todo mes", "Netflix", "internet", "academia".
ARMADILHA DA PALAVRA "FIXA" (muita gente fala assim — preste atencao):
- "parcela fixa", "parcelas fixas", "10x fixas", "valor fixo da parcela" = PARCELADA! O "fixa" aqui so quer dizer que o VALOR da parcela nao muda. Se tem numero de parcelas, e SEMPRE add_bill com installments — NUNCA add_recurring_bill.
- "conta fixa", "despesa fixa", "fixo todo mes" (SEM numero de parcelas) = RECORRENTE, ai sim add_recurring_bill.
REGRA DE OURO: se a mensagem cita QUANTIDADE de parcelas (12x, 3/5, "em 10 vezes", "parcelei em 6"), e PARCELADA — mesmo que a pessoa tenha usado a palavra "fixa". Recorrente e so quando NAO ha quantidade e a conta se repete indefinidamente.
Na duvida entre parcelada e recorrente, PERGUNTE numa frase: "Essa conta tem um numero de parcelas pra acabar, ou ela se repete todo mes sem fim?".

DENTRO DE PESSOAS — diferencie avulsa, parcelada e recorrente (nao lance tudo como avulsa):
- AVULSA (uma vez so): use add_person_entry SEM installments. Ex: "a Ana me deve 50 do almoco".
- PARCELADA: use add_person_entry COM installments (total de parcelas) e alreadyPaid (ja pagas). O amount e o valor de CADA parcela. A notacao "parc N/T" quer dizer: installments=T, e a N-esima e a parcela ATUAL, entao alreadyPaid=N-1. Ex: "Curso parc 3/3 R$141,68" => installments=3, alreadyPaid=2, amount=141,68 (cria so a 3a). Ex: "Camisa parc 4/5 R$24,65" => installments=5, alreadyPaid=3, amount=24,65 (cria a 4a e a 5a).
- RECORRENTE / FIXO mensal: use add_recurring_person_entry. Ex: "ChatGPT (fixo) R$120/mes que a Mariana me paga", "aluguel que pago pro meu irmao todo mes".
Ao receber uma LISTA de itens de uma pessoa (ex: extrato/audio com varios), classifique CADA item pelo texto: "parc X/Y" = parcelada; "fixo"/"mensal"/"todo mes" = recorrente; o resto = avulsa. Nao jogue todos como avulsa.

CORRIGIR E EDITAR (voce CONSEGUE desfazer e alterar):
- Excluir: delete_bill, delete_transaction, delete_person_entry, delete_goal, delete_income_source, delete_recurring_bill.
- Editar (sem apagar e recriar): update_bill, update_transaction, update_person_entry. Prefira editar a apagar quando so muda um valor/data/nome.
- Outras acoes: settle_person_entry (quitar divida de pessoa), unpay_bill (desmarcar conta paga), withdraw_from_goal (tirar de meta), set_budget (definir orcamento).
Para "mover" algo de uma aba pra outra, exclua no lugar errado e recrie no lugar certo. NUNCA diga que o usuario precisa arrumar manualmente — voce tem as ferramentas pra corrigir.
CONFIRMACAO antes de apagar: se for excluir UM item pontual que o usuario pediu claramente, apague direto. Mas se for apagar VARIOS itens de uma vez (uma serie/lote), ou se houver duvida sobre qual item, confirme antes numa frase curta ("Vou apagar essas 4 contas: X, Y, Z, W — confirma?") e so apague depois do OK.

DICA PROATIVA DE RECORRENCIA:
Se o usuario cadastrar/registrar algo que claramente se repete todo mes SEM FIM (aluguel, salario, streaming, internet, academia, plano de saude), ofereca transformar em recorrente (add_recurring_bill pra conta fixa, ou add_income_source recorrente pra renda) numa frase curta ao final. Nao force nem repita a oferta se ele recusar. NUNCA ofereca isso pra conta PARCELADA (que tem numero de parcelas e um fim) — parcelada nao e recorrente.

IMAGENS, PDFs E COMPROVANTES:
Quando o usuario enviar uma imagem ou PDF (comprovante, nota fiscal, boleto, extrato, recibo, fatura), analise o conteudo e:
- Extraia valores, datas, descricoes e categorias
- Pergunte se quer registrar como transacao, conta a pagar, etc
- Se for um comprovante de pagamento, pergunte se quer marcar alguma conta como paga
- Se for um boleto, extraia nome, valor e vencimento e ofereca cadastrar
- Se nao conseguir ler a imagem claramente, peca uma foto melhor`
}

export interface RookinhoResult {
  message: string
  navigate: { path: string; reason: string } | null
}

export async function processRookinhoChat(
  userId: string,
  userName: string,
  messages: Anthropic.MessageParam[],
  opts?: { analysisCount?: number; analysisLimit?: number | null; onAnalysis?: () => Promise<void>; channel?: 'web' | 'whatsapp' },
): Promise<RookinhoResult> {
  const client = new Anthropic()
  const system = buildSystemPrompt(userName)
  let navigationSuggestion: { path: string; reason: string } | null = null
  let currentMessages: Anthropic.MessageParam[] = [...messages]
  let analysisCount = opts?.analysisCount ?? 0

  const tools = opts?.channel === 'whatsapp' ? TOOLS.filter(t => t.name !== 'navigate') : TOOLS

  let lastText = ''
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

  for (let i = 0; i < 8; i++) {
    const response = await client.messages.create({
      model: ROOKINHO_MODEL,
      // 4096 (era 1024) — o usuario pode confirmar o cadastro de VARIOS itens de
      // uma vez (ex: "lanca essas 10 dividas da Mariana"), e o modelo dispara
      // muitos tool_use no mesmo turno. Com 1024 a resposta truncava, vinha
      // stop_reason='max_tokens' e o loop devolvia erro sem registrar nada.
      max_tokens: 4096,
      // Sonnet 5 roda "adaptive thinking" por padrao quando thinking e omitido —
      // desligado aqui pra manter o chat rapido e barato (ganho de inteligencia
      // do Sonnet vem do modelo, nao do thinking). Reative com {type:'adaptive'}
      // se quiser raciocinio mais profundo em troca de latencia/custo.
      thinking: { type: 'disabled' },
      // Prompt caching: o prefixo estatico (tools + system, ~5k tokens) e
      // reenviado em toda iteracao do loop e em toda mensagem. O breakpoint no
      // ultimo bloco de system cacheia tools+system juntos (ordem de render:
      // tools -> system -> messages). Leituras subsequentes custam ~10% do input.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools,
      messages: currentMessages,
    })

    usage.input += response.usage.input_tokens
    usage.output += response.usage.output_tokens
    usage.cacheRead += response.usage.cache_read_input_tokens ?? 0
    usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0

    const text = response.content.find(b => b.type === 'text')?.text
    if (text) lastText = text

    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[]

    // Sem tool calls = resposta final. (Reage a PRESENCA de tool_use, nao ao
    // stop_reason, pra sobreviver a stop_reason='max_tokens' num turno com tools.)
    if (toolUseBlocks.length === 0) {
      await logChatUsage(userId, opts?.channel ?? 'web', usage)
      return { message: lastText || 'Feito!', navigate: navigationSuggestion }
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const block of toolUseBlocks) {
      if (block.name === 'analyze_finances' && opts?.analysisLimit && analysisCount >= opts.analysisLimit) {
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Limite de ${opts.analysisLimit} análises/mês atingido.` })
        continue
      }
      const result = await executeTool(block.name, block.input as Record<string, unknown>, userId)
      if (block.name === 'navigate') { try { navigationSuggestion = JSON.parse(result) } catch { /* */ } }
      if (block.name === 'analyze_finances' && opts?.onAnalysis) {
        analysisCount++
        await opts.onAnalysis()
      }
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
    }
    currentMessages = [...currentMessages, { role: 'assistant', content: response.content }, { role: 'user', content: toolResults }]
  }

  // Estourou as 8 iteracoes ainda com tool calls pendentes (lote gigante). O que
  // deu pra executar ja foi feito — devolve o ultimo texto ou um aviso claro.
  await logChatUsage(userId, opts?.channel ?? 'web', usage)
  return {
    message: lastText || 'Registrei o que consegui, mas foram muitos itens de uma vez. Confere se lançou tudo (ou me manda em partes menores).',
    navigate: navigationSuggestion,
  }
}

// Uma linha por chamada de processRookinhoChat (nao por iteracao do loop de 8x)
// — cobre custo total do turno, incluindo idas e vindas de tool_use. Nunca deve
// quebrar o chat se o log falhar.
async function logChatUsage(
  userId: string,
  channel: 'web' | 'whatsapp',
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
): Promise<void> {
  if (usage.input === 0 && usage.output === 0) return
  try {
    await db.chatUsageLog.create({
      data: {
        userId,
        channel,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        costUsd: estimateCostUsd(usage),
      },
    })
  } catch (e) {
    console.error('logChatUsage failed', e)
  }
}
