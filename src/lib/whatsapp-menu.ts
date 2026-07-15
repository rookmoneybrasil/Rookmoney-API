import { db } from './db'
import { money } from './rookinho-core'
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

/** So dispara o menu quando a mensagem e SO uma saudacao/pedido de menu.
 *  "oi, paguei a luz" NAO cai aqui — vai pro Rookinho, como deve ser. */
export function isMenuTrigger(text: string): boolean {
  return GREETING_RE.test(text.trim())
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
  return `Opa, ${first}! 🐂 Sou o Rookinho.\n\n` +
    `Escolhe uma opção abaixo pra ser mais rápido — ou simplesmente me manda o que precisa (pode ser áudio ou print de comprovante) que eu resolvo.`
}

/** Resultado de uma selecao de menu.
 *  handled=false => o webhook deve escalar pro Rookinho (IA). */
export interface MenuResult {
  handled: boolean
  reply?: string
  /** Se true, o webhook deve mandar o menu de novo depois da resposta. */
  showMenuAgain?: boolean
}

export async function handleMenuSelection(id: string, userId: string, userName: string): Promise<MenuResult> {
  switch (id) {
    case 'menu_resumo':
      return { handled: true, reply: await formatResumo(userId) }
    case 'menu_contas':
      return { handled: true, reply: await formatContas(userId) }
    case 'menu_pessoas':
      return { handled: true, reply: await formatPessoas(userId) }
    case 'menu_cadastrar':
      // Etapa 2 vai virar fluxo guiado (pergunta avulsa/parcelada/fixa em botoes).
      // Por enquanto entrega pro Rookinho com a pergunta certa ja feita.
      return {
        handled: true,
        reply: 'Beleza! Me conta em uma mensagem: o **nome** da conta, o **valor** e o **vencimento**.\n\n' +
          'E me diz qual é o caso:\n' +
          '• *Avulsa* — paga uma vez só\n' +
          '• *Parcelada* — tem número de parcelas (ex: 12x)\n' +
          '• *Fixa* — repete todo mês, sem fim\n\n' +
          'Pode mandar tudo junto, tipo: "Sofá 10x de R$150, primeira dia 20".',
      }
    case 'menu_rookinho':
      return {
        handled: true,
        reply: `Tô aqui, ${userName?.split(' ')[0] ?? ''}! Manda o que precisa — pode ser texto, áudio ou print de comprovante. 😉`.replace('  ', ' '),
      }
    default:
      return { handled: false }
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
