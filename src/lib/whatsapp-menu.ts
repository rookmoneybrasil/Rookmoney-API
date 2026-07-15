import { db } from './db'
import { money, executeTool } from './rookinho-core'
import { processRecurringBills } from './process-recurring-bills'
import { processRecurringPersonEntries } from './process-recurring-people'
import { format, startOfMonth, endOfMonth } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import type { ListRow } from './whatsapp'

// ── Menu do WhatsApp (atalho, NAO portao) ───────────────────────────────────
// Filosofia: o menu e um ATALHO opcional. Texto livre, audio e print continuam
// indo direto pro Rookinho (IA) — o menu nunca bloqueia a conversa natural,
// porque falar natural e justamente o diferencial do produto no WhatsApp.
//
// Ganho: as opcoes de leitura resolvem no banco, sem chamar a IA — custo ZERO
// de tokens. Isso importa porque o PRO+ tem mensagens ilimitadas.

const GREETING_RE = /^\s*(oi+|ol[aá]+|e a[ií]|opa|hey|bom dia|boa tarde|boa noite|menu|ajuda|help|op[cç][oõ]es|come[cç]ar|start|in[ií]cio|voltar)[\s!.,?]*$/i

// Palavras que abrem o menu, toleradas com erro de digitacao ("meni", "mneu").
const MENU_WORDS = ['menu', 'ajuda', 'opcoes', 'comecar', 'inicio', 'start', 'help', 'voltar']

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

/** Damerau-Levenshtein: conta transposicao de vizinhos como 1 edicao, entao
 *  pega "mneu" (que Levenshtein puro contaria como 2). */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
      }
    }
  }
  return d[m][n]
}

/** So dispara o menu quando a mensagem e SO uma saudacao/pedido de menu.
 *  "oi, paguei a luz" NAO cai aqui — vai pro Rookinho, como deve ser.
 *  Tolera 1 erro de digitacao numa palavra unica ("meni", "mneu", "menuu").
 *  Limite de 1 edicao de proposito: com 2, "comprar" casaria com "comecar" e
 *  "meta" chegaria perto de "menu" — palavras que sao comandos de verdade. */
export function isMenuTrigger(text: string): boolean {
  const t = text.trim()
  if (GREETING_RE.test(t)) return true
  if (t.split(/\s+/).length > 1) return false // so mensagem de UMA palavra
  const word = stripAccents(t.toLowerCase()).replace(/[^a-z]/g, '')
  if (word.length < 3 || word.length > 12) return false
  return MENU_WORDS.some(kw => editDistance(word, kw) <= 1)
}

export const MENU_BUTTON_TEXT = 'Ver opções'

export const MAIN_MENU_ROWS: ListRow[] = [
  { id: 'menu_resumo',   title: '📊 Resumo do mês',      description: 'Receitas, despesas e saldo' },
  { id: 'menu_contas',   title: '📄 Contas a pagar',     description: 'O que está pendente e vencido' },
  { id: 'menu_pessoas',  title: '👥 Quem me deve',       description: 'Dívidas e créditos com pessoas' },
  { id: 'menu_cadastrar', title: '➕ Cadastrar conta',   description: 'Avulsa, parcelada ou fixa' },
  { id: 'menu_rookinho', title: '💬 Falar com o Rookinho', description: 'Pergunte, mande print ou áudio' },
]

export function menuGreeting(userName: string): string {
  const first = userName?.split(' ')[0] ?? 'por aí'
  return `Opa, ${first}! 👋 Sou o Rookinho.\n\n` +
    `Escolhe uma opção abaixo pra ser mais rápido — ou simplesmente me manda o que precisa (pode ser áudio ou print de comprovante) que eu resolvo.`
}

/** Resultado de uma selecao de menu ou passo de fluxo.
 *  handled=false => o webhook deve escalar pro Rookinho (IA). */
export interface MenuResult {
  handled: boolean
  reply?: string
  /** Se presente, o webhook manda botoes em vez de texto puro (max 3). */
  buttons?: { id: string; title: string }[]
  /** Se true, o webhook manda a lista do menu principal. */
  showMenu?: boolean
}

/** Agradecimento/confirmacao seca ("ok", "valeu"). Responde canned, ZERO token —
 *  sem isso um "Ok" depois de um cadastro caia na IA e gastava mensagem a toa. */
const ACK_RE = /^\s*(ok(ay)?|okey|blz|beleza|show|joia|jóia|valeu|vlw|obrigad[oa]|brigad[oa]|thanks|tks|perfeito|isso|certo|top|massa|legal|entendi|👍|🙏|👌|😄|😁)[\s!.,]*$/i

export function isAck(text: string): boolean {
  return ACK_RE.test(text.trim())
}

export function ackReply(): string {
  return 'Tamo junto! 👊 Se precisar de mais alguma coisa é só chamar — manda *menu* pra ver as opções.'
}

// ── Fluxo guiado de cadastro de conta ───────────────────────────────────────
// Aqui esta o ganho de CONFIABILIDADE: em vez de a IA adivinhar se "parcela
// fixa" e parcelada ou recorrente, o usuario escolhe no botao. Zero ambiguidade
// e zero token. A criacao reusa executeTool() do rookinho-core — mesma logica
// de parcelamento/recorrencia ja testada, so que sem passar pela IA.

type BillType = 'avulsa' | 'parcelada' | 'fixa'

interface FlowState {
  step: 'type' | 'name' | 'amount' | 'installments' | 'alreadyPaid' | 'dueDate' | 'dayOfMonth'
  type?: BillType
  data: { name?: string; amount?: number; installments?: number; alreadyPaid?: number }
  updatedAt: number
}

const flows = new Map<string, FlowState>()
const FLOW_TTL = 15 * 60 * 1000

setInterval(() => {
  const now = Date.now()
  for (const [k, v] of flows) if (now - v.updatedAt > FLOW_TTL) flows.delete(k)
}, 60 * 1000)

export function hasActiveFlow(userId: string): boolean {
  const f = flows.get(userId)
  if (!f) return false
  if (Date.now() - f.updatedAt > FLOW_TTL) { flows.delete(userId); return false }
  return true
}

export function clearFlow(userId: string): void {
  flows.delete(userId)
}

const CANCEL_RE = /^\s*(cancelar|cancela|sair|parar|desisto|menu)[\s!.]*$/i

export async function handleMenuSelection(id: string, userId: string, userName: string): Promise<MenuResult> {
  switch (id) {
    case 'menu_resumo':
      return { handled: true, reply: await formatResumo(userId) }
    case 'menu_contas':
      return { handled: true, reply: await formatContas(userId) }
    case 'menu_pessoas':
      return { handled: true, reply: await formatPessoas(userId) }
    case 'menu_cadastrar':
      flows.set(userId, { step: 'type', data: {}, updatedAt: Date.now() })
      return {
        handled: true,
        reply: 'Boa! Que tipo de conta é essa?\n\n' +
          '• *Avulsa* — paga uma vez só\n' +
          '• *Parcelada* — tem nº de parcelas (ex: 12x)\n' +
          '• *Fixa* — repete todo mês, sem fim',
        buttons: [
          { id: 'bill_avulsa', title: 'Avulsa' },
          { id: 'bill_parcelada', title: 'Parcelada' },
          { id: 'bill_fixa', title: 'Fixa mensal' },
        ],
      }

    case 'bill_avulsa':
    case 'bill_parcelada':
    case 'bill_fixa': {
      const type = id.replace('bill_', '') as BillType
      flows.set(userId, { step: 'name', type, data: {}, updatedAt: Date.now() })
      return { handled: true, reply: 'Qual o *nome* da conta? (ex: Sofá, Internet, IPVA)\n\n_Manda "cancelar" a qualquer momento pra sair._' }
    }
    case 'menu_rookinho':
      return {
        handled: true,
        reply: `Tô aqui, ${userName?.split(' ')[0] ?? ''}! Manda o que precisa — pode ser texto, áudio ou print de comprovante. 😉`.replace('  ', ' '),
      }

    // ── Desfecho do fluxo ────────────────────────────────────────────────────
    case 'menu_voltar':
      clearFlow(userId)
      return { handled: true, showMenu: true }

    case 'flow_done':
      clearFlow(userId)
      return {
        handled: true,
        reply: 'Show! Tá tudo registrado. ✅\n\nQuando precisar, é só me chamar — manda *menu* pra ver as opções, ou fala comigo normal que eu resolvo.',
      }
    default:
      return { handled: false }
  }
}

// ── Parsers tolerantes (o usuario digita como quiser) ───────────────────────

function parseMoney(s: string): number | null {
  const cleaned = s.replace(/[^\d,.]/g, '').trim()
  if (!cleaned) return null
  // "1.234,56" -> 1234.56 | "150,50" -> 150.50 | "150.50" -> 150.50 | "150" -> 150
  const norm = cleaned.includes(',') ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned
  const n = parseFloat(norm)
  return Number.isFinite(n) && n > 0 ? n : null
}

function parseCount(s: string): number | null {
  if (/^\s*(n[ãa]o|nenhuma|nenhum|zero|0)\s*$/i.test(s)) return 0
  const m = s.match(/\d+/)
  if (!m) return null
  const n = parseInt(m[0], 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

const MONTHS: Record<string, number> = {
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
  jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
}

/** Aceita "20", "20/07", "20/07/2026" e por extenso ("20 de junho", "dia 20 de jul de 2026").
 *  Só o dia => este mês (ou o próximo, se já passou). Mês por extenso é respeitado
 *  literalmente (não rola pro ano seguinte) — se a pessoa disse junho, é junho. */
function parseDueDate(s: string): string | null {
  const t = s.trim().replace(/^dia\s+/i, '').trim()
  const now = new Date()
  let d: number, m: number, y: number

  const full = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  const dm = t.match(/^(\d{1,2})\/(\d{1,2})$/)
  const only = t.match(/^(\d{1,2})$/)
  const named = t.match(/^(\d{1,2})\s*(?:de\s+)?([a-zà-ú]{3,})(?:\s*(?:de\s+)?(\d{2,4}))?$/i)

  if (full) {
    d = +full[1]; m = +full[2]; y = +full[3]
    if (y < 100) y += 2000
  } else if (dm) {
    d = +dm[1]; m = +dm[2]; y = now.getFullYear()
  } else if (only) {
    d = +only[1]; m = now.getMonth() + 1; y = now.getFullYear()
    if (d < now.getDate()) { m += 1; if (m > 12) { m = 1; y += 1 } }
  } else if (named && MONTHS[named[2].toLowerCase().slice(0, 3)]) {
    d = +named[1]
    m = MONTHS[named[2].toLowerCase().slice(0, 3)]
    y = named[3] ? (+named[3] < 100 ? +named[3] + 2000 : +named[3]) : now.getFullYear()
  } else return null

  if (d < 1 || d > 31 || m < 1 || m > 12) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

// ── Passo a passo do fluxo ──────────────────────────────────────────────────

/** Retorna null se o usuario NAO esta num fluxo (ai o webhook escala pro Rookinho). */
export async function handleFlowStep(userId: string, text: string): Promise<MenuResult | null> {
  const flow = flows.get(userId)
  if (!flow || Date.now() - flow.updatedAt > FLOW_TTL) {
    flows.delete(userId)
    return null
  }

  if (CANCEL_RE.test(text)) {
    flows.delete(userId)
    return { handled: true, reply: 'Beleza, cancelei. Manda "menu" quando quiser as opções. 😉' }
  }

  // Ainda esperando o botao de tipo — usuario digitou em vez de tocar
  if (flow.step === 'type') {
    const t = text.toLowerCase()
    const type: BillType | null = /parcel/.test(t) ? 'parcelada' : /fix|mensal|recorrent/.test(t) ? 'fixa' : /avuls|[uú]nic/.test(t) ? 'avulsa' : null
    if (!type) {
      return {
        handled: true,
        reply: 'Toca num dos botões pra eu saber o tipo:',
        buttons: [
          { id: 'bill_avulsa', title: 'Avulsa' },
          { id: 'bill_parcelada', title: 'Parcelada' },
          { id: 'bill_fixa', title: 'Fixa mensal' },
        ],
      }
    }
    flows.set(userId, { step: 'name', type, data: {}, updatedAt: Date.now() })
    return { handled: true, reply: 'Qual o *nome* da conta? (ex: Sofá, Internet, IPVA)' }
  }

  flow.updatedAt = Date.now()

  switch (flow.step) {
    case 'name': {
      const name = text.trim().slice(0, 60)
      if (!name) return { handled: true, reply: 'Não peguei o nome. Como você quer chamar essa conta?' }
      flow.data.name = name
      flow.step = 'amount'
      const pergunta = flow.type === 'parcelada'
        ? 'Qual o valor de *cada parcela*? (ex: 150,00)'
        : flow.type === 'fixa'
          ? 'Qual o valor *por mês*? (ex: 99,90)'
          : 'Qual o *valor*? (ex: 250,00)'
      return { handled: true, reply: pergunta }
    }

    case 'amount': {
      const amount = parseMoney(text)
      if (amount === null) return { handled: true, reply: 'Não entendi o valor. Manda só o número, tipo: 150 ou 150,50' }
      flow.data.amount = amount
      if (flow.type === 'parcelada') {
        flow.step = 'installments'
        return { handled: true, reply: 'Em *quantas parcelas* no total? (ex: 12)' }
      }
      if (flow.type === 'fixa') {
        flow.step = 'dayOfMonth'
        return { handled: true, reply: 'Todo mês, em que *dia* ela vence? (ex: 10)' }
      }
      flow.step = 'dueDate'
      return { handled: true, reply: 'Quando *vence*? (ex: 20, 20/07 ou 20/07/2026)' }
    }

    case 'installments': {
      const n = parseCount(text)
      if (n === null || n < 2) return { handled: true, reply: 'Manda o número total de parcelas (2 ou mais). Ex: 12' }
      flow.data.installments = n
      flow.step = 'alreadyPaid'
      return { handled: true, reply: `Dessas ${n}, *quantas você já pagou*? (se nenhuma, manda "não")` }
    }

    case 'alreadyPaid': {
      const n = parseCount(text)
      const total = flow.data.installments ?? 1
      if (n === null || n >= total) return { handled: true, reply: `Manda quantas já foram pagas (de 0 a ${total - 1}), ou "não" se nenhuma.` }
      flow.data.alreadyPaid = n
      flow.step = 'dueDate'
      return { handled: true, reply: 'Quando vence a *próxima parcela*? (ex: 20, 20/07 ou 20/07/2026)' }
    }

    case 'dueDate': {
      const dueDate = parseDueDate(text)
      if (!dueDate) return { handled: true, reply: 'Não entendi a data. Manda assim: *20*, *20/07*, *20/07/2026* ou *20 de julho*.' }
      flows.delete(userId)
      return finishFlow(await createBill(userId, flow, dueDate))
    }

    case 'dayOfMonth': {
      const d = parseCount(text)
      if (d === null || d < 1 || d > 31) return { handled: true, reply: 'Manda o dia do mês, de 1 a 31. Ex: 10' }
      flows.delete(userId)
      return finishFlow(await createBill(userId, flow, undefined, d))
    }
  }

  flows.delete(userId)
  return null
}

/** Desfecho: confirma o cadastro e oferece a saida em botoes. Sem isso o usuario
 *  respondia "Ok" no vazio e a mensagem caia na IA (token gasto a toa). */
function finishFlow(confirmation: string): MenuResult {
  return {
    handled: true,
    reply: `${confirmation}\n\nQuer cadastrar mais alguma coisa?`,
    buttons: [
      { id: 'menu_cadastrar', title: 'Cadastrar outra' },
      { id: 'menu_voltar', title: 'Ver menu' },
      { id: 'flow_done', title: 'Finalizar' },
    ],
  }
}

async function createBill(userId: string, flow: FlowState, dueDate?: string, dayOfMonth?: number): Promise<string> {
  const { name, amount = 0, installments, alreadyPaid = 0 } = flow.data
  try {
    if (flow.type === 'fixa') {
      return await executeTool('add_recurring_bill', { name, amount, dayOfMonth }, userId)
    }
    if (flow.type === 'parcelada' && installments) {
      // executeTool('add_bill') divide `amount` pelas parcelas RESTANTES. Como aqui
      // perguntamos o valor de CADA parcela, multiplicamos de volta pelo restante —
      // assim a divisao la dentro devolve exatamente o valor da parcela.
      const remaining = installments - alreadyPaid
      return await executeTool('add_bill', { name, amount: amount * remaining, dueDate, installments, alreadyPaid }, userId)
    }
    return await executeTool('add_bill', { name, amount, dueDate }, userId)
  } catch (e) {
    console.error('[whatsapp-menu] createBill failed:', e)
    return 'Ops, não consegui cadastrar agora. Tenta de novo ou me manda por texto que eu resolvo.'
  }
}

// ── Formatters (consultas diretas ao banco — zero token) ────────────────────

async function formatResumo(userId: string): Promise<string> {
  const now = new Date()
  const mS = startOfMonth(now), mE = endOfMonth(now)
  const [income, expense] = await Promise.all([
    db.transaction.aggregate({ where: { userId, type: 'INCOME', date: { gte: mS, lte: mE } }, _sum: { amount: true } }),
    db.transaction.aggregate({ where: { userId, type: 'EXPENSE', date: { gte: mS, lte: mE } }, _sum: { amount: true } }),
  ])
  const ti = Number(income._sum.amount ?? 0)
  const te = Number(expense._sum.amount ?? 0)
  const saldo = ti - te
  const mes = format(now, 'MMMM', { locale: ptBR })

  return `📊 *Resumo de ${mes}*\n\n` +
    `• Receitas: ${money(ti)}\n` +
    `• Despesas: ${money(te)}\n` +
    `• Saldo: ${money(saldo)}\n\n` +
    (saldo >= 0 ? 'Tá no azul, continua assim! 👏' : 'Tá no vermelho esse mês, hein. Bora ajustar?')
}

async function formatContas(userId: string): Promise<string> {
  // Gera as recorrentes do mes antes de ler, igual as telas do app fazem —
  // senao o menu mostraria menos contas do que o app.
  await processRecurringBills(userId).catch(() => {})

  const now = new Date()
  const bills = await db.bill.findMany({
    where: { userId, isPaid: false },
    orderBy: { dueDate: 'asc' },
    take: 20,
    select: { name: true, amount: true, dueDate: true, installmentCurrent: true, installmentTotal: true },
  })
  if (bills.length === 0) return '📄 *Contas a pagar*\n\nNenhuma conta pendente. Tá tudo em dia! 🎉'

  const fmt = (b: typeof bills[number]) => {
    const parc = b.installmentTotal ? ` (${b.installmentCurrent}/${b.installmentTotal})` : ''
    return `• ${b.name}${parc} — ${money(b.amount)} — vence ${format(b.dueDate, 'dd/MM')}`
  }
  const vencidas = bills.filter(b => b.dueDate < now)
  const proximas = bills.filter(b => b.dueDate >= now)
  const total = bills.reduce((s, b) => s + Number(b.amount), 0)

  let out = '📄 *Contas a pagar*\n'
  if (vencidas.length) out += `\n⚠️ *Vencidas (${vencidas.length})*\n${vencidas.map(fmt).join('\n')}\n`
  if (proximas.length) out += `\n🗓️ *A vencer*\n${proximas.map(fmt).join('\n')}\n`
  out += `\n*Total pendente: ${money(total)}*`
  if (vencidas.length) out += '\n\nTem conta vencida aí, paga logo essas! 😬'
  return out
}

async function formatPessoas(userId: string): Promise<string> {
  await processRecurringPersonEntries(userId).catch(() => {})

  const people = await db.person.findMany({
    where: { userId },
    select: { name: true, entries: { where: { isSettled: false }, select: { type: true, amount: true } } },
  })
  const rows = people
    .map(p => {
      const meDevem = p.entries.filter(e => e.type === 'THEY_OWE_ME').reduce((s, e) => s + Number(e.amount), 0)
      const euDevo = p.entries.filter(e => e.type === 'I_OWE_THEM').reduce((s, e) => s + Number(e.amount), 0)
      return { name: p.name, saldo: meDevem - euDevo }
    })
    .filter(p => p.saldo !== 0)

  if (rows.length === 0) return '👥 *Pessoas*\n\nNinguém te deve e você não deve ninguém. Tudo quitado! ✨'

  const meDevem = rows.filter(r => r.saldo > 0)
  const euDevo = rows.filter(r => r.saldo < 0)

  let out = '👥 *Pessoas*\n'
  if (meDevem.length) {
    out += `\n🟢 *Te devem*\n${meDevem.map(r => `• ${r.name} — ${money(r.saldo)}`).join('\n')}\n`
    out += `Total a receber: ${money(meDevem.reduce((s, r) => s + r.saldo, 0))}\n`
  }
  if (euDevo.length) {
    out += `\n🔴 *Você deve*\n${euDevo.map(r => `• ${r.name} — ${money(-r.saldo)}`).join('\n')}\n`
    out += `Total a pagar: ${money(euDevo.reduce((s, r) => s + -r.saldo, 0))}\n`
  }
  return out.trimEnd()
}
