import type { NextApiRequest, NextApiResponse } from 'next'
import { db } from '@/lib/db'
import { format, addDays, startOfMonth, endOfMonth, subMonths } from 'date-fns'
import { sendBillReminderEmail, sendMonthlySummaryEmail, sendManualProExpiryWarningEmail, sendChurnAlertEmail } from '@/lib/email'
import { cleanupExpiredLimits } from '@/lib/rate-limit'
import { sendPush, isValidPushToken } from '@/lib/push'

async function migrateOldRecurring(userId: string) {
  const now = new Date()
  const entries = await db.personEntry.findMany({
    where: { userId, isSettled: false, installmentGroupId: { not: null }, installmentTotal: { gte: 24 } },
    orderBy: { installmentCurrent: 'asc' },
  })
  const groupMap = new Map<string, typeof entries>()
  for (const e of entries) {
    const arr = groupMap.get(e.installmentGroupId!) ?? []
    arr.push(e)
    groupMap.set(e.installmentGroupId!, arr)
  }
  for (const [groupId, group] of groupMap.entries()) {
    const hasSettled = await db.personEntry.count({ where: { installmentGroupId: groupId, isSettled: true } })
    if (hasSettled > 0) continue
    const first = group[0]
    const existing = await db.personEntryRecurring.findFirst({
      where: { userId, personId: first.personId, description: first.description, isActive: true },
    })
    if (!existing) {
      await db.personEntryRecurring.create({
        data: {
          userId, personId: first.personId, type: first.type,
          description: first.description, amount: first.amount,
          dayOfMonth: Math.min(new Date(first.date).getDate(), 31),
          notes: first.notes, categoryId: first.categoryId,
          lastMonth: format(now, 'yyyy-MM'),
        },
      })
    }
    const upcoming = group.filter(e => new Date(e.date) >= now).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    // Delete ALL entries in the group — cron will create next one from template
    await db.personEntry.deleteMany({ where: { installmentGroupId: groupId, userId } })
  }
}

async function processAutoIncome(userId: string) {
  const now       = new Date()
  const today     = now.getDate()
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

  const sources = await db.incomeSource.findMany({ where: { userId, isRecurring: true } })

  for (const src of sources) {
    if (!src.categoryId || !src.dayOfMonth) continue
    if (src.lastAutoPayMonth === yearMonth) continue
    if (today < src.dayOfMonth) continue
    // Don't auto-pay if startDate is in the future
    if (src.startDate && src.startDate > now) continue
    await db.$transaction([
      db.transaction.create({ data: { amount: src.amount, type: 'INCOME', description: src.name, date: new Date(now.getFullYear(), now.getMonth(), src.dayOfMonth), userId, categoryId: src.categoryId } }),
      db.incomeSource.update({ where: { id: src.id }, data: { lastAutoPayMonth: yearMonth } }),
    ])
  }
}

async function processPersonEntryRecurring(userId: string) {
  const now       = new Date()
  const today     = now.getDate()
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

  const items = await db.personEntryRecurring.findMany({ where: { userId, isActive: true } })

  for (const item of items) {
    if (item.lastMonth === yearMonth) continue
    if (today < item.dayOfMonth) continue

    const entryDate = new Date(now.getFullYear(), now.getMonth(), item.dayOfMonth)

    await db.$transaction([
      db.personEntry.create({
        data: {
          personId:   item.personId,
          userId,
          type:       item.type,
          description: item.description,
          amount:     item.amount,
          date:       entryDate,
          notes:      item.notes,
          categoryId: item.categoryId,
        },
      }),
      db.personEntryRecurring.update({ where: { id: item.id }, data: { lastMonth: yearMonth } }),
    ])
  }
}

async function processAutoRecurring(userId: string) {
  const now       = new Date()
  const today     = now.getDate()
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

  const items = await db.recurringTransaction.findMany({ where: { userId, isActive: true, frequency: 'MONTHLY' } })

  for (const item of items) {
    if (!item.categoryId) continue
    if (item.lastAutoMonth === yearMonth) continue
    if (item.dayOfMonth && today < item.dayOfMonth) continue
    await db.$transaction([
      db.transaction.create({ data: { amount: item.amount, type: item.type, description: item.name, date: new Date(now.getFullYear(), now.getMonth(), item.dayOfMonth ?? 1), userId, categoryId: item.categoryId } }),
      db.recurringTransaction.update({ where: { id: item.id }, data: { lastAutoMonth: yearMonth } }),
    ])
  }
}


async function processRecurringBills(userId: string) {
  const now       = new Date()
  const today     = now.getDate()
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const y = now.getFullYear()
  const m = now.getMonth() // 0-based

  const templates = await db.recurringBill.findMany({
    where: { userId, isActive: true, OR: [{ lastAutoMonth: null }, { lastAutoMonth: { not: yearMonth } }] },
  })
  if (templates.length === 0) return

  for (const t of templates) {
    // No day-of-month gate — bills are generated at month start so users see them immediately.

    const day     = Math.min(t.dayOfMonth, new Date(y, m + 1, 0).getDate())
    const dueDate = new Date(Date.UTC(y, m, day, 12, 0, 0))

    const monthStart = new Date(Date.UTC(y, m, 1))
    const monthEnd   = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59))

    const exists = await db.bill.findFirst({
      where: { userId, recurringBillId: t.id, dueDate: { gte: monthStart, lte: monthEnd } },
    })
    if (exists) {
      await db.recurringBill.update({ where: { id: t.id }, data: { lastAutoMonth: yearMonth } })
      continue
    }

    await db.$transaction([
      db.bill.create({
        data: { name: t.name, amount: t.amount, dueDate, isRecurring: false, userId, categoryId: t.categoryId ?? null, notes: t.notes ?? null, recurringBillId: t.id },
      }),
      db.recurringBill.update({ where: { id: t.id }, data: { lastAutoMonth: yearMonth } }),
    ])
  }
}

async function warnExpiringManualPro() {
  const now      = new Date()
  const in3Days  = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000)
  const in4Days  = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000)

  // Warn users expiring in ~3 days (between 3d and 4d from now)
  const expiringSoon = await db.user.findMany({
    where: { plan: { in: ['PRO', 'PRO_PLUS'] }, stripeSubscriptionId: null, proPlanExpiresAt: { gte: in3Days, lt: in4Days } },
    select: { email: true, name: true, proPlanExpiresAt: true },
  })
  for (const u of expiringSoon) {
    if (!u.proPlanExpiresAt) continue
    const days = Math.ceil((u.proPlanExpiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    await sendManualProExpiryWarningEmail(u.email, u.name, u.proPlanExpiresAt, days)
      .catch(e => console.error('[expire-warn] 3d email failed:', e))
  }

  // Warn users expiring today
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)
  const expiringToday = await db.user.findMany({
    where: { plan: { in: ['PRO', 'PRO_PLUS'] }, stripeSubscriptionId: null, proPlanExpiresAt: { gte: now, lt: tomorrow } },
    select: { email: true, name: true, proPlanExpiresAt: true },
  })
  for (const u of expiringToday) {
    if (!u.proPlanExpiresAt) continue
    await sendManualProExpiryWarningEmail(u.email, u.name, u.proPlanExpiresAt, 0)
      .catch(e => console.error('[expire-warn] today email failed:', e))
  }
}

async function expireManualPro() {
  const expired = await db.user.findMany({
    where: { plan: { in: ['PRO', 'PRO_PLUS'] }, stripeSubscriptionId: null, proPlanExpiresAt: { not: null, lte: new Date() } },
    select: { id: true, email: true },
  })
  for (const u of expired) {
    await db.user.update({ where: { id: u.id }, data: { plan: 'FREE', proPlanExpiresAt: null, proPlanReason: null } })
    await db.adminLog.create({ data: {
      action: 'plan_change', targetId: u.id,
      details: `PRO manual expirado automaticamente → FREE (${u.email})`,
    }})
  }
}

async function checkChurnAlert() {
  // Only run on the 2nd — after month rollover has been processed
  if (new Date().getDate() !== 2) return

  const prevMonth = subMonths(new Date(), 1)
  const pS        = startOfMonth(prevMonth)
  const pE        = endOfMonth(prevMonth)

  const [churnCount, thresholdRow, emailRow] = await Promise.all([
    db.adminLog.count({
      where: { action: 'plan_change', details: { contains: 'para FREE' }, createdAt: { gte: pS, lte: pE } },
    }),
    db.appSetting.findUnique({ where: { key: 'churn_alert_threshold' } }),
    db.appSetting.findUnique({ where: { key: 'admin_alert_email' } }),
  ])

  const threshold  = parseInt(thresholdRow?.value ?? '5')
  const adminEmail = emailRow?.value ?? 'viniguilherme013@gmail.com'

  if (churnCount >= threshold) {
    const monthLabel = prevMonth.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
    await sendChurnAlertEmail(adminEmail, churnCount, threshold, monthLabel)
      .catch(e => console.error('[churn-alert] email failed:', e))
  }
}

async function sendNotifications(): Promise<number> {
  const now     = new Date()
  const today   = now.getDate()
  const hour    = now.getHours()
  const slot    = today * 10 + hour
  const in3Days = addDays(now, 3)
  let sentCount = 0

  const users = await db.user.findMany({
    where: { pushToken: { not: null } },
    select: {
      id: true, name: true, email: true, plan: true,
      notifBillReminder: true, notifCategoryLimit: true, notifMonthlyEmail: true,
      pushToken: true, lastActiveAt: true, createdAt: true,
    },
  })

  for (const user of users) {
    if (!isValidPushToken(user.pushToken)) continue
    try {
      const pushes: { title: string; body: string; screen: string }[] = []

      const firstName = (user.name ?? '').split(' ')[0] || 'aí'

      // ── 1. Bills due within 3 days ──────────────────────────────────────
      if (user.notifBillReminder) {
        const dueSoon = await db.bill.findMany({
          where: { userId: user.id, isPaid: false, dueDate: { gte: now, lte: in3Days } },
          select: { name: true, amount: true, dueDate: true },
        })
        if (dueSoon.length > 0) {
          await sendBillReminderEmail(user.email, user.name, dueSoon.map(b => ({
            name: b.name, amount: Number(b.amount), dueDate: new Date(b.dueDate),
          }))).catch(e => console.error('[notify] bill email failed:', e))

          const titles = dueSoon.map(b => b.name).slice(0, 2).join(', ')
          const extra  = dueSoon.length > 2 ? ` +${dueSoon.length - 2}` : ''
          const billMsgs = [
            { title: `🐦 Ei ${firstName}, bora pagar?`, body: `${titles}${extra} vence${dueSoon.length > 1 ? 'm' : ''} em breve. Não me faz passar vergonha!` },
            { title: '🐦 Rookinho aqui, ó', body: `Conta de ${titles}${extra} tá chegando. Paga logo antes que eu fique nervoso!` },
            { title: `🐦 ${firstName}! Conta batendo na porta`, body: `${titles}${extra} vence${dueSoon.length > 1 ? 'm' : ''} nos próximos dias. Bora resolver isso?` },
          ]
          pushes.push({ ...billMsgs[slot % billMsgs.length], screen: 'bills' })
        }
      }

      // ── 2. Budget alerts (>80% used) ────────────────────────────────────
      if (user.notifCategoryLimit) {
        const monthStr = format(now, 'yyyy-MM')
        const mS = startOfMonth(now)
        const mE = endOfMonth(now)
        const budgets = await db.budget.findMany({
          where: { userId: user.id, month: monthStr },
          include: { category: true },
        })
        if (budgets.length > 0) {
          const expenses = await db.transaction.findMany({
            where: { userId: user.id, type: 'EXPENSE', date: { gte: mS, lte: mE } },
            select: { categoryId: true, amount: true },
          })
          const spentByCategory = new Map<string, number>()
          for (const t of expenses) {
            if (t.categoryId) spentByCategory.set(t.categoryId, (spentByCategory.get(t.categoryId) ?? 0) + Number(t.amount))
          }
          const overBudget: string[] = []
          for (const bgt of budgets) {
            const spent = spentByCategory.get(bgt.categoryId) ?? 0
            const pct = Number(bgt.amount) > 0 ? Math.round((spent / Number(bgt.amount)) * 100) : 0
            if (pct >= 100) overBudget.push(bgt.category.name)
            else if (pct >= 80 && overBudget.length === 0) overBudget.push(`${bgt.category.name} (${pct}%)`)
          }
          if (overBudget.length > 0) {
            const cat = overBudget[0]
            const budgetMsgs = [
              { title: '🐦 Para de gastar!', body: `${cat} tá estourando o orçamento. Eu avisei, ${firstName}!` },
              { title: `🐦 ${firstName}, calma aí`, body: `${cat} já passou de 80% do limite. Segura a mão!` },
              { title: '🐦 Alerta do Rookinho', body: `Orçamento de ${cat} no limite. Quer ficar no vermelho? Acho que não né.` },
            ]
            pushes.push({ ...budgetMsgs[slot % budgetMsgs.length], screen: 'budget' })
          }
        }
      }

      // ── 3. Goal approaching deadline ────────────────────────────────────
      const urgentGoals = await db.goal.findMany({
        where: { userId: user.id, isCompleted: false, deadline: { gte: now, lte: addDays(now, 7) } },
        select: { name: true, currentAmount: true, targetAmount: true, deadline: true },
      })
      if (urgentGoals.length > 0) {
        const g = urgentGoals[0]
        const pct = Number(g.targetAmount) > 0 ? Math.round((Number(g.currentAmount) / Number(g.targetAmount)) * 100) : 0
        const days = Math.ceil((new Date(g.deadline!).getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
        const goalMsgs = [
          { title: '🐦 Cadê o dinheiro da meta?', body: `"${g.name}" tá em ${pct}% e faltam ${days} dia${days !== 1 ? 's' : ''}. Bora, ${firstName}!` },
          { title: `🐦 ${firstName}, a meta tá chorando`, body: `"${g.name}" precisa de atenção — ${pct}% com ${days} dia${days !== 1 ? 's' : ''} restantes.` },
        ]
        pushes.push({ ...goalMsgs[slot % goalMsgs.length], screen: 'goals' })
      }

      // ── 4. Daily spending summary (yesterday) ──────────────────────────
      const yesterday = addDays(now, -1)
      const yStart = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate())
      const yEnd   = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 23, 59, 59)
      const yesterdaySpent = await db.transaction.aggregate({
        where: { userId: user.id, type: 'EXPENSE', date: { gte: yStart, lte: yEnd } },
        _sum: { amount: true }, _count: true,
      })
      const spent = Number(yesterdaySpent._sum.amount ?? 0)
      if (spent > 0 && pushes.length === 0) {
        const spendMsgs = spent > 200
          ? [
              { title: '🐦 Eita, gastou hein!', body: `R$ ${spent.toFixed(2)} ontem em ${yesterdaySpent._count} transaç${yesterdaySpent._count === 1 ? 'ão' : 'ões'}. Tá rico, ${firstName}?` },
              { title: `🐦 ${firstName}, cê tá bem?`, body: `R$ ${spent.toFixed(2)} voaram ontem. O Rookinho ficou preocupado.` },
            ]
          : [
              { title: '🐦 Resuminho de ontem', body: `Gastou R$ ${spent.toFixed(2)} ontem. Tá controlado, ${firstName}? Eu tô de olho!` },
              { title: '🐦 Boa, controlado!', body: `R$ ${spent.toFixed(2)} ontem. Nada mal! Continua assim que o Rookinho aprova.` },
            ]
        pushes.push({ ...spendMsgs[slot % spendMsgs.length], screen: 'transactions' })
      }

      // ── 5. Reengagement (inactive — escalates with days) ───────────────
      if (pushes.length === 0 && user.lastActiveAt) {
        const daysSince = Math.floor((now.getTime() - new Date(user.lastActiveAt).getTime()) / (1000 * 60 * 60 * 24))
        if (daysSince >= 2) {
          let msg: { title: string; body: string }
          if (daysSince <= 3) {
            const pool = [
              { title: `🐦 ${firstName}, sumiu?`, body: `Faz ${daysSince} dias que não te vejo. Suas contas não se pagam sozinhas!` },
              { title: `🐦 Oi ${firstName}!`, body: `${daysSince} dias sem registrar nada. Bora atualizar rapidinho?` },
            ]
            msg = pool[daysSince % pool.length]
          } else if (daysSince <= 7) {
            const pool = [
              { title: '🐦 Alô?? Tem alguém aí?', body: `${daysSince} dias sem abrir o app. O Rookinho tá aqui sozinho e triste.` },
              { title: `🐦 ${firstName}, volta aqui!`, body: `Faz ${daysSince} dias! Tô juntando poeira aqui. Bora organizar essas finanças?` },
              { title: '🐦 O Rookinho tá bravo', body: `${daysSince} dias sem registrar nada? Assim não dá. Abre o app!` },
            ]
            msg = pool[daysSince % pool.length]
          } else if (daysSince <= 14) {
            const pool = [
              { title: `🐦 ${firstName}, tô preocupado`, body: `Já são ${daysSince} dias. Suas finanças tão largadas. O Rookinho não dorme em paz assim.` },
              { title: '🐦 Cadê você??', body: `${daysSince} dias, ${firstName}. Eu sei que a vida é corrida, mas 2 minutinhos resolve. Volta!` },
            ]
            msg = pool[daysSince % pool.length]
          } else {
            const pool = [
              { title: `🐦 ${firstName}... ainda tô aqui`, body: `${daysSince} dias sem te ver. Se precisar, o Rookinho tá esperando. Sempre.` },
              { title: '🐦 Saudades de você', body: `Faz ${daysSince} dias. O app tá igualzinho, te esperando. Bora voltar, ${firstName}?` },
              { title: `🐦 Oi ${firstName}, lembra de mim?`, body: `Sou o Rookinho! Faz ${daysSince} dias. Suas finanças sentem sua falta.` },
            ]
            msg = pool[daysSince % pool.length]
          }
          pushes.push({ ...msg, screen: '/(tabs)' })
        }
      }

      // ── 5b. Never logged in after signup (>1 day, no lastActiveAt) ─────
      if (pushes.length === 0 && !user.lastActiveAt) {
        const daysSinceSignup = Math.floor((now.getTime() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24))
        if (daysSinceSignup >= 1) {
          const pool = [
            { title: `🐦 Ei ${firstName}!`, body: 'Você criou sua conta mas ainda não começou. Bora registrar seu primeiro gasto?' },
            { title: `🐦 ${firstName}, tô te esperando!`, body: 'Cadastrou mas não voltou? O Rookinho tá aqui pronto pra te ajudar!' },
            { title: '🐦 Primeira vez é de graça', body: `${firstName}, abre o app e registra um gasto. Leva 10 segundos, prometo!` },
          ]
          pushes.push({ ...pool[daysSinceSignup % pool.length], screen: '/(tabs)' })
        }
      }

      // ── 6. PRO upsell for FREE users (2x/week — Tue & Sat) ─────────────
      if (pushes.length === 0 && user.plan === 'FREE') {
        const dayOfWeek = now.getDay() // 0=Sun
        if (dayOfWeek === 2 || dayOfWeek === 6) {
          const proPool = [
            // FOMO / exclusividade
            { title: '🐦 Tá perdendo coisa boa', body: `${firstName}, os PRO têm orçamento ilimitado, relatórios e o Rookinho IA. Você tá de fora!`, screen: 'settings' },
            { title: `🐦 ${firstName}, sério mesmo?`, body: 'Ainda no grátis? Quem é PRO já tá controlando tudo. Não fica pra trás!', screen: 'settings' },
            // Rookinho IA
            { title: '🐦 Quer falar comigo?', body: `${firstName}, no PRO eu viro seu assistente financeiro pessoal. Posso analisar seus gastos, criar contas, dar dicas... Bora?`, screen: 'ai-chat' },
            { title: `🐦 ${firstName}, eu sou mais esperto do que pareço`, body: 'No PRO eu leio seus extratos, respondo dúvidas e até crio transações por você. Experimenta!', screen: 'ai-chat' },
            // Limites
            { title: '🐦 Limite é pra quem quer', body: `${firstName}, no grátis você tem limite de contas e metas. No PRO? Ilimitado. Sem frescura.`, screen: 'settings' },
            { title: `🐦 Ei ${firstName}`, body: 'Sabia que no FREE você só pode ter 5 contas por mês? No PRO é infinito. Pensa nisso.', screen: 'settings' },
            // Provocação direta
            { title: '🐦 Rookinho sincerão', body: `${firstName}, cê quer organizar suas finanças de verdade ou só de brincadeira? PRO é pra quem leva a sério.`, screen: 'settings' },
            { title: `🐦 ${firstName}, posso ser honesto?`, body: 'O plano grátis é bom, mas o PRO é outro nível. Orçamento, relatórios, IA... R$19,90/mês. Menos que um iFood.', screen: 'settings' },
            // Social proof
            { title: '🐦 Todo mundo tá virando PRO', body: `${firstName}, quem assina o PRO não volta pro grátis. Será que sabem de algo que você não sabe?`, screen: 'settings' },
            { title: `🐦 ${firstName}, confia no Rookinho`, body: 'Já ajudei muita gente a sair do vermelho com o PRO. Bora ser o próximo?', screen: 'settings' },
            // Urgência / preço
            { title: '🐦 Faz as contas', body: `R$19,90 por mês = R$0,66 por dia. ${firstName}, isso é menos que um café. E muda sua vida financeira.`, screen: 'settings' },
            { title: `🐦 ${firstName}, última chance?`, body: 'Brincadeira, não é última chance. Mas e se fosse? Ia continuar no grátis? Bora de PRO!', screen: 'settings' },
          ]
          const idx = (slot + now.getMonth()) % proPool.length
          pushes.push(proPool[idx])
        }
      }

      // ── 7. Monthly summary — only on the 1st ───────────────────────────
      if (user.notifMonthlyEmail && today === 1) {
        const prevMonth = subMonths(now, 1)
        const pS = startOfMonth(prevMonth)
        const pE = endOfMonth(prevMonth)
        const [income, expense] = await Promise.all([
          db.transaction.aggregate({ where: { userId: user.id, type: 'INCOME',  date: { gte: pS, lte: pE } }, _sum: { amount: true } }),
          db.transaction.aggregate({ where: { userId: user.id, type: 'EXPENSE', date: { gte: pS, lte: pE } }, _sum: { amount: true } }),
        ])
        const totalIncome  = Number(income._sum.amount  ?? 0)
        const totalExpense = Number(expense._sum.amount ?? 0)
        await sendMonthlySummaryEmail(user.email, user.name, {
          month:       format(prevMonth, 'MMMM yyyy'),
          income:      totalIncome,
          expense:     totalExpense,
          balance:     totalIncome - totalExpense,
          savingsRate: totalIncome > 0 ? Math.round(((totalIncome - totalExpense) / totalIncome) * 100) : 0,
        }).catch(e => console.error('[notify] monthly email failed:', e))

        const bal = totalIncome - totalExpense
        const monthName = format(prevMonth, 'MMMM')
        if (bal >= 0) {
          pushes.push({ title: `🐦 Mês fechado, ${firstName}!`, body: `${monthName}: sobrou R$ ${bal.toFixed(2)}. O Rookinho tá orgulhoso!`, screen: 'reports' })
        } else {
          pushes.push({ title: `🐦 ${firstName}, precisamos conversar`, body: `${monthName}: ficou R$ ${Math.abs(bal).toFixed(2)} no vermelho. Bora ajustar esse mês?`, screen: 'reports' })
        }
      }

      // ── 8. Daily tips & feature discovery (always, if no other push) ───
      if (pushes.length === 0) {
        const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / (1000 * 60 * 60 * 24))
        const tips = [
          { title: `🐦 Dica do Rookinho`, body: `${firstName}, sabia que dá pra dividir uma conta em parcelas? Tenta lá em Contas!`, screen: 'bills' },
          { title: `🐦 Ô ${firstName}`, body: 'Já criou seu orçamento do mês? Sem orçamento é igual dirigir sem GPS!', screen: 'budget' },
          { title: '🐦 Rookinho ensina', body: `${firstName}, sabia que dá pra registrar quem te deve dinheiro? Vai em Pessoas!`, screen: 'people' },
          { title: `🐦 E aí ${firstName}`, body: 'Já cadastrou suas metas financeiras? Viagem, celular novo, reserva... Bora sonhar!', screen: 'goals' },
          { title: '🐦 Dica esperta', body: `${firstName}, cadastra suas rendas fixas e elas entram sozinhas todo mês. Magia!`, screen: 'income' },
          { title: `🐦 Fala ${firstName}`, body: 'Sabia que dá pra ver relatórios completos dos seus gastos? Confere em Relatórios!', screen: 'reports' },
          { title: '🐦 Psiu', body: `${firstName}, já experimentou o calendário financeiro? Vê tudo que entra e sai no mês!`, screen: 'calendar' },
          { title: `🐦 Bom dia, ${firstName}!`, body: 'Registrar gastos todo dia é o segredo. 2 minutinhos e pronto. O Rookinho agradece!', screen: '/(tabs)' },
          { title: '🐦 Rookinho avisa', body: `${firstName}, contas recorrentes tipo Netflix e internet podem ser automáticas. Já configurou?`, screen: 'recurring' },
          { title: `🐦 Ei ${firstName}`, body: 'Quanto você gastou no iFood esse mês? Categoriza certinho que eu te mostro!', screen: 'transactions' },
          { title: '🐦 Curiosidade', body: `${firstName}, a regra dos 50/30/20 é: 50% necessidades, 30% desejos, 20% poupança. Bora tentar?`, screen: 'budget' },
          { title: `🐦 Opa ${firstName}`, body: 'Sabia que importar seu extrato bancário é rapidinho? Vai em Transações e tenta!', screen: 'transactions' },
          { title: '🐦 Dica de ouro', body: `${firstName}, paga as contas assim que cair o salário. Futuro-você vai agradecer!`, screen: 'bills' },
          { title: `🐦 ${firstName}!`, body: 'Já olhou quanto gastou por categoria esse mês? Às vezes a gente se assusta, mas é bom saber!', screen: 'reports' },
        ]
        pushes.push(tips[(dayOfYear + hour) % tips.length])
      }

      // ── Send up to 2 pushes: highest-priority + a second if different type ──
      const toSend = [pushes[0]]
      if (pushes.length > 1 && pushes[1].title !== pushes[0].title) {
        toSend.push(pushes[1])
      }
      for (const p of toSend) {
        await sendPush([{
          to:    user.pushToken!,
          title: p.title,
          body:  p.body,
          data:  { screen: p.screen },
          sound: 'default',
        }]).catch(e => console.error('[notify] push failed:', e))
        await db.pushLog.create({ data: { userId: user.id, title: p.title, body: p.body, screen: p.screen } })
          .catch(e => console.error('[pushlog] save failed:', e))
      }
      sentCount++
    } catch (err) {
      console.error(`[notify] user ${user.id}:`, err)
    }
  }
  return sentCount
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end()

  const secret = process.env.CRON_SECRET
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const users = await db.user.findMany({ select: { id: true } })

  let processed = 0
  const errors: string[] = []

  for (const user of users) {
    try {
      await migrateOldRecurring(user.id)
      await processAutoIncome(user.id)
      await processAutoRecurring(user.id)
      await processPersonEntryRecurring(user.id)
      await processRecurringBills(user.id)
      processed++
    } catch (err) {
      errors.push(`${user.id}: ${String(err)}`)
    }
  }

  await warnExpiringManualPro().catch(e => console.error('[expire-warn] fatal:', e))
  await expireManualPro().catch(e => console.error('[expire-pro] fatal:', e))
  await checkChurnAlert().catch(e => console.error('[churn-alert] fatal:', e))

  // Send notifications — await so we can report count
  let pushSent = 0
  try {
    pushSent = await sendNotifications()
  } catch (e) {
    console.error('[notify] fatal:', e)
  }
  cleanupExpiredLimits().catch(e => console.error('[rate-limit] cleanup failed:', e))

  // Blog auto-generation — Monday and Thursday
  let blogGenerated = false
  const dayOfWeek = new Date().getDay()
  if (dayOfWeek === 1 || dayOfWeek === 4) {
    try {
      const blogRes = await fetch(`${process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'http://localhost:3000'}/api/cron/blog-generate`, {
        method: 'GET',
        headers: { 'x-cron-secret': process.env.CRON_SECRET ?? '' },
      })
      const blogJson = await blogRes.json()
      blogGenerated = blogJson.ok && !blogJson.skipped
    } catch (e) {
      console.error('[blog-generate] fatal:', e)
    }
  }

  return res.status(200).json({ ok: true, processed, pushSent, blogGenerated, errors })
}
