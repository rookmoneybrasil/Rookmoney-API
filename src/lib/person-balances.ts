import { db } from './db'
import type { Person } from '../generated/prisma/client'
import { processRecurringPersonEntries } from './process-recurring-people'

/**
 * Saldo por pessoa (te deve / voce deve) — FONTE UNICA DA VERDADE.
 *
 * Extraido de GET /api/v1/people pra ser consumido tambem pelo menu do WhatsApp.
 * NAO reimplemente essa conta em outro lugar: a regra e sutil (lancamento avulso
 * conta em qualquer data, parcela SO conta no mes corrente, recorrente legado tem
 * cutoff, template recorrente tem gate de startMonth) e ja gerou uma familia de
 * bugs de "divida fantasma". Duplicar essa logica = numero diferente entre o app
 * e o WhatsApp. Ver CLAUDE.md > "Pessoas — agregacao de valores".
 */
/** Todos os campos do Person + os agregados. O spread de `rest` e proposital:
 *  o GET /people devolvia a pessoa inteira (notes, createdAt, userId...) e o web
 *  usa `person.notes` — enxugar isso quebraria os clientes. */
export type PersonBalance = Omit<Person, 'entries' | 'recurring' | 'user'> & {
  theyOweMe: number
  iOweThem: number
  balance: number
  openEntriesCount: number
}

export async function computePersonBalances(userId: string): Promise<PersonBalance[]> {
  // Best-effort: uma falha transitoria aqui nao pode impedir o usuario de ver os dados.
  await processRecurringPersonEntries(userId).catch(err =>
    console.error('[person-balances] processRecurringPersonEntries failed:', err))

  const now        = new Date()
  const yearMonth  = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)
  // Cutoff so pro recorrente antigo (installmentTotal >= 24) ainda nao migrado
  const cutoff = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000)

  const [people, recurringAll] = await Promise.all([
    db.person.findMany({
      where:   { userId },
      orderBy: { name: 'asc' },
      include: {
        entries: {
          select: { type: true, amount: true, date: true, installmentTotal: true, installmentGroupId: true, isSettled: true, recurringEntryId: true },
        },
        _count: { select: { entries: { where: { isSettled: false } } } },
      },
    }),
    db.personEntryRecurring.findMany({
      where:  { userId, isActive: true },
      select: { id: true, personId: true, type: true, amount: true, startMonth: true },
    }),
  ])

  return people.map(p => {
    let theyOweMe = 0
    let iOweThem  = 0

    for (const e of p.entries) {
      if (e.isSettled) continue // settled so serve pra deteccao de duplicata abaixo
      const isOldRecurring = (e.installmentTotal ?? 0) >= 24
      if (isOldRecurring && new Date(e.date) > cutoff) continue
      if (e.installmentGroupId) {
        // Parcela so conta se vencer no mes corrente (espelha a pagina de detalhe)
        const eDate = new Date(e.date)
        if (eDate.getFullYear() !== now.getFullYear() || eDate.getMonth() !== now.getMonth()) continue
      }
      if (e.type === 'THEY_OWE_ME') theyOweMe += Number(e.amount)
      else                          iOweThem  += Number(e.amount)
    }

    // Soma o template recorrente so quando ainda NAO existe PersonEntry dele neste
    // mes (o processRecurringPersonEntries acima cria assim que o dayOfMonth passa)
    // — casado pela FK recurringEntryId, nao por heuristica de descricao/data.
    for (const r of recurringAll.filter(r => r.personId === p.id)) {
      // Ainda nao comecou (1a data futura) → nao conta ate o mes dela chegar
      if (r.startMonth && yearMonth < r.startMonth) continue
      // Escopo no mes corrente: senao um lancamento passado (ja quitado) desse
      // template casaria e suprimiria errado o valor ainda nao gerado deste mes.
      const alreadyHasEntry = p.entries.some(e =>
        e.recurringEntryId === r.id &&
        new Date(e.date) >= monthStart && new Date(e.date) <= monthEnd,
      )
      if (alreadyHasEntry) continue
      if (r.type === 'THEY_OWE_ME') theyOweMe += Number(r.amount)
      else                          iOweThem  += Number(r.amount)
    }

    const { entries, _count, ...rest } = p
    return {
      ...rest,
      balance: theyOweMe - iOweThem,
      theyOweMe,
      iOweThem,
      openEntriesCount: _count.entries,
    }
  })
}
