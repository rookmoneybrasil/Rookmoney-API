import { db } from './db'
import { processRecurringBills } from './process-recurring-bills'
import { processRecurringPersonEntries } from './process-recurring-people'

/**
 * Auto-processamento do mes — FONTE UNICA DA VERDADE.
 *
 * Gera o que deveria existir no mes corrente antes de qualquer LEITURA de saldo:
 * renda recorrente, transacoes recorrentes, contas fixas e dividas recorrentes.
 *
 * Quem le saldo/resumo SEM rodar isso mostra numero DEFASADO: se o usuario nao
 * abriu o app no mes, o salario ainda nao virou Transaction e a receita aparece
 * como R$ 0. Era o caso do get_summary do Rookinho e do resumo do menu do
 * WhatsApp — o app mostrava o salario e o WhatsApp mostrava zero.
 *
 * Chamado por: GET /dashboard, get_summary (tool), menu do WhatsApp.
 * allSettled de proposito: falha transitoria num gerador nao pode impedir o
 * usuario de ver os dados que ja existem.
 */
export async function autoProcessMonth(userId: string): Promise<void> {
  await Promise.allSettled([
    processAutoIncome(userId),
    processAutoRecurring(userId),
    processRecurringBills(userId),
    processRecurringPersonEntries(userId),
  ])
}

/** Gera a Transaction de INCOME das fontes de renda recorrentes cujo dia ja passou. */
export async function processAutoIncome(uid: string): Promise<void> {
  const now       = new Date()
  const today     = now.getDate()
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const sources   = await db.incomeSource.findMany({ where: { userId: uid, isRecurring: true } })
  for (const src of sources) {
    if (src.lastAutoPayMonth === yearMonth) continue
    if (!src.categoryId) continue
    const day = src.dayOfMonth ?? 1
    if (today < day) continue
    // Nao auto-paga se a startDate ainda e futura
    if (src.startDate && src.startDate > now) continue
    await db.$transaction([
      db.transaction.create({ data: { amount: src.amount, type: 'INCOME', description: src.name, date: new Date(now.getFullYear(), now.getMonth(), day), userId: uid, categoryId: src.categoryId } }),
      db.incomeSource.update({ where: { id: src.id }, data: { lastAutoPayMonth: yearMonth } }),
    ])
  }
}

/** Gera a Transaction das RecurringTransaction mensais cujo dia ja passou. */
export async function processAutoRecurring(uid: string): Promise<void> {
  const now       = new Date()
  const today     = now.getDate()
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const items     = await db.recurringTransaction.findMany({ where: { userId: uid, isActive: true, frequency: 'MONTHLY' } })
  for (const item of items) {
    if (item.lastAutoMonth === yearMonth) continue
    if (!item.categoryId) continue
    const day = item.dayOfMonth ?? 1
    if (today < day) continue
    await db.$transaction([
      db.transaction.create({ data: { amount: item.amount, type: item.type, description: item.name, date: new Date(now.getFullYear(), now.getMonth(), day), userId: uid, categoryId: item.categoryId } }),
      db.recurringTransaction.update({ where: { id: item.id }, data: { lastAutoMonth: yearMonth } }),
    ])
  }
}
