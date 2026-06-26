import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'
import { format, addDays, startOfMonth, endOfMonth } from 'date-fns'
import { isPro } from '@/lib/plans'

type NotifType    = 'bill' | 'goal' | 'budget' | 'person' | 'income' | 'rookinho'
type NotifUrgency = 'high' | 'medium' | 'low'
interface Notification { id: string; type: NotifType; title: string; message: string; href: string; urgency: NotifUrgency }

export default withAuth(async (req, res, session) => {
  if (req.method !== 'GET') return res.status(405).end()

  const uid   = session.userId
  const now   = new Date()
  const in3   = addDays(now, 3)
  const in7   = addDays(now, 7)
  const month = format(now, 'yyyy-MM')
  const dayOfMonth = now.getDate()

  const [user, bills, goals, budgets, txs, incomeSources, people] = await Promise.all([
    db.user.findUnique({ where: { id: uid }, select: { name: true, plan: true } }),
    db.bill.findMany({ where: { userId: uid, isPaid: false, dueDate: { gte: now, lte: in3 } }, orderBy: { dueDate: 'asc' } }),
    db.goal.findMany({ where: { userId: uid, isCompleted: false, deadline: { gte: now, lte: in7 } }, orderBy: { deadline: 'asc' } }),
    db.budget.findMany({ where: { userId: uid, month }, include: { category: true } }),
    db.transaction.findMany({ where: { userId: uid, type: 'EXPENSE', date: { gte: startOfMonth(now), lte: endOfMonth(now) } } }),
    db.incomeSource.findMany({ where: { userId: uid, isRecurring: true } }),
    db.person.findMany({ where: { userId: uid }, include: { entries: { where: { isSettled: false } } } }),
  ])

  const notifications: Notification[] = []

  for (const b of bills) {
    const diff = Math.ceil((new Date(b.dueDate).getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    const when = diff <= 0 ? 'vence hoje' : diff === 1 ? 'vence amanhã' : `vence em ${diff} dias`
    notifications.push({ id: `bill-${b.id}`, type: 'bill', title: b.name, message: `${when} · R$ ${Number(b.amount).toFixed(2)}`, href: '/bills', urgency: diff <= 1 ? 'high' : 'medium' })
  }

  for (const g of goals) {
    if (!g.deadline) continue
    const diff = Math.ceil((new Date(g.deadline).getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    const pct  = Number(g.targetAmount) > 0 ? Math.round((Number(g.currentAmount) / Number(g.targetAmount)) * 100) : 0
    notifications.push({ id: `goal-${g.id}`, type: 'goal', title: g.name, message: `${pct}% concluída · prazo em ${diff} dias`, href: '/goals', urgency: pct < 50 ? 'high' : 'medium' })
  }

  for (const bgt of budgets) {
    const spent = txs.filter(t => t.categoryId === bgt.categoryId).reduce((s, t) => s + Number(t.amount), 0)
    const pct   = Number(bgt.amount) > 0 ? Math.round((spent / Number(bgt.amount)) * 100) : 0
    if (pct >= 80) {
      notifications.push({ id: `budget-${bgt.id}`, type: 'budget', title: bgt.category.name, message: `${pct}% do orçamento utilizado`, href: '/budget', urgency: pct >= 100 ? 'high' : 'medium' })
    }
  }

  // Income sources: notify when dayOfMonth is within 7 days
  for (const src of incomeSources) {
    if (!src.dayOfMonth) continue
    const daysUntil = src.dayOfMonth - dayOfMonth
    if (daysUntil < 0 || daysUntil > 7) continue
    const when = daysUntil === 0 ? 'entra hoje' : daysUntil === 1 ? 'entra amanhã' : `entra em ${daysUntil} dias`
    notifications.push({
      id: `income-${src.id}`,
      type: 'income',
      title: src.name,
      message: `${when} · R$ ${Number(src.amount).toFixed(2)}`,
      href: '/income',
      urgency: daysUntil <= 3 ? 'medium' : 'low',
    })
  }

  // People: outstanding balances
  for (const person of people) {
    let theyOweMe = 0
    let iOweThem  = 0
    for (const e of person.entries) {
      if (e.type === 'THEY_OWE_ME') theyOweMe += Number(e.amount)
      else                           iOweThem  += Number(e.amount)
    }
    const net = theyOweMe - iOweThem
    if (Math.abs(net) < 1) continue
    const theyOweMeNet = net > 0
    notifications.push({
      id: `person-${person.id}`,
      type: 'person',
      title: person.name,
      message: theyOweMeNet
        ? `Te deve R$ ${net.toFixed(2)}`
        : `Você deve R$ ${Math.abs(net).toFixed(2)}`,
      href: '/people',
      urgency: theyOweMeNet ? 'medium' : 'low',
    })
  }

  // ── Rookinho daily message ────────────────────────────────────────
  const firstName = (user?.name ?? '').split(' ')[0] || 'aí'
  const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / (1000 * 60 * 60 * 24))

  if (user && !isPro(user.plan)) {
    const proTips = [
      { title: `🐦 Tá perdendo coisa boa, ${firstName}`, message: 'Os PRO têm orçamento ilimitado, relatórios e o Rookinho IA. Você tá de fora!', href: '/settings' },
      { title: `🐦 ${firstName}, sério mesmo?`, message: 'Ainda no grátis? Quem é PRO já tá controlando tudo. Não fica pra trás!', href: '/settings' },
      { title: '🐦 Quer falar comigo?', message: `${firstName}, no PRO eu viro seu assistente financeiro pessoal. Bora?`, href: '/chat' },
      { title: `🐦 ${firstName}, posso ser honesto?`, message: 'O grátis é bom, mas o PRO é outro nível. R$19,90/mês. Menos que um iFood.', href: '/settings' },
      { title: '🐦 Faz as contas', message: `R$0,66 por dia, ${firstName}. Isso é menos que um café. E muda sua vida financeira.`, href: '/settings' },
      { title: '🐦 Rookinho sincerão', message: `${firstName}, quer organizar de verdade ou só de brincadeira? PRO é pra quem leva a sério.`, href: '/settings' },
      { title: '🐦 Todo mundo tá virando PRO', message: 'Quem assina não volta pro grátis. Será que sabem algo que você não sabe?', href: '/settings' },
    ]
    notifications.push({ id: 'rookinho-pro', type: 'rookinho', ...proTips[dayOfYear % proTips.length], urgency: 'low' })
  }

  const dailyTips = [
    { title: '🐦 Dica do Rookinho', message: `${firstName}, sabia que dá pra dividir uma conta em parcelas? Tenta lá em Contas!`, href: '/bills' },
    { title: `🐦 Ô ${firstName}`, message: 'Já criou seu orçamento do mês? Sem orçamento é igual dirigir sem GPS!', href: '/budget' },
    { title: '🐦 Rookinho ensina', message: `${firstName}, sabia que dá pra registrar quem te deve? Vai em Pessoas!`, href: '/people' },
    { title: `🐦 E aí ${firstName}`, message: 'Já cadastrou suas metas? Viagem, celular novo, reserva... Bora sonhar!', href: '/goals' },
    { title: '🐦 Dica esperta', message: `${firstName}, cadastra rendas fixas e elas entram sozinhas todo mês. Magia!`, href: '/income' },
    { title: `🐦 Fala ${firstName}`, message: 'Sabia que dá pra ver relatórios completos dos seus gastos?', href: '/reports' },
    { title: '🐦 Psiu', message: `${firstName}, já experimentou o calendário financeiro? Vê tudo que entra e sai!`, href: '/calendar' },
    { title: `🐦 Bom dia, ${firstName}!`, message: 'Registrar gastos todo dia é o segredo. 2 minutinhos e pronto!', href: '/' },
    { title: '🐦 Rookinho avisa', message: `${firstName}, contas tipo Netflix e internet podem ser automáticas. Já configurou?`, href: '/recurring' },
    { title: `🐦 Ei ${firstName}`, message: 'Quanto gastou no iFood esse mês? Categoriza certinho que eu te mostro!', href: '/transactions' },
    { title: '🐦 Curiosidade', message: `Regra 50/30/20: 50% necessidades, 30% desejos, 20% poupança. Bora tentar, ${firstName}?`, href: '/budget' },
    { title: `🐦 ${firstName}!`, message: 'Já olhou quanto gastou por categoria esse mês? Às vezes a gente se assusta!', href: '/reports' },
    { title: '🐦 Dica de ouro', message: `${firstName}, paga as contas assim que cair o salário. Futuro-você vai agradecer!`, href: '/bills' },
    { title: `🐦 Opa ${firstName}`, message: 'Importar extrato bancário é rapidinho. Vai em Transações e tenta!', href: '/transactions' },
  ]
  notifications.push({ id: 'rookinho-tip', type: 'rookinho', ...dailyTips[dayOfYear % dailyTips.length], urgency: 'low' })

  return ok(res, notifications)
})
