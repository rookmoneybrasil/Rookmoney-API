import { db } from './db'
import type { Person } from '../generated/prisma/client'
import { processRecurringPersonEntries } from './process-recurring-people'

/**
 * Saldo por pessoa (te deve / voce deve) — FONTE UNICA DA VERDADE.
 *
 * A REGRA (mesma da pagina de detalhe da pessoa no web/mobile — que e a correta):
 *   1. ignora quitado
 *   2. ignora linha do mes de template PAUSADO
 *   3. recorrente legado (installmentTotal >= 24) tem cutoff de 45 dias
 *   4. conta tudo devido ate o FIM DO MES CORRENTE (atrasado + este mes), pra
 *      avulsa E parcela. Futuro pertence a projecao, nao ao "Voce deve"
 *   5. soma o template recorrente ativo que ainda nao gerou linha neste mes
 *      (casado pela FK recurringEntryId), respeitando o gate de startMonth
 *
 * NAO reimplemente essa conta em outro lugar. Ela ja divergiu 4 vezes: a lista
 * (GET /people) descartava parcela ATRASADA e contava avulsa FUTURA, enquanto o
 * detalhe contava certo — dois numeros pro mesmo saldo, no mesmo app. O
 * comentario da lista ate dizia "mirrors detail page logic" e nao espelhava.
 * Ver CLAUDE.md > "Pessoas — agregacao de valores".
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
          select: { id: true, type: true, amount: true, date: true, installmentTotal: true, installmentGroupId: true, isSettled: true, recurringEntryId: true },
        },
        _count: { select: { entries: { where: { isSettled: false } } } },
      },
    }),
    // Todos os templates (nao so os ativos): os inativos sao necessarios pra
    // identificar linha do mes gerada por template PAUSADO, que nao deve contar.
    db.personEntryRecurring.findMany({
      where:  { userId },
      select: { id: true, personId: true, type: true, amount: true, startMonth: true, isActive: true },
    }),
  ])

  return people.map(p => {
    let theyOweMe = 0
    let iOweThem  = 0

    const templates = recurringAll.filter(r => r.personId === p.id)
    const activeIds = new Set(templates.filter(r => r.isActive).map(r => r.id))

    // Linha do mes gerada por template PAUSADO nao conta. Pausar deveria apagar a
    // linha nao paga (ver CLAUDE.md), isso cobre o legado que ficou pra tras.
    const pausedMonthEntryIds = new Set(
      p.entries
        .filter(e => e.recurringEntryId && !activeIds.has(e.recurringEntryId) &&
          new Date(e.date) >= monthStart && new Date(e.date) <= monthEnd)
        .map(e => e.id),
    )

    for (const e of p.entries) {
      if (e.isSettled) continue // settled so serve pra deteccao de duplicata abaixo
      if (pausedMonthEntryIds.has(e.id)) continue
      const isOldRecurring = (e.installmentTotal ?? 0) >= 24
      if (isOldRecurring && new Date(e.date) > cutoff) continue
      // Conta tudo devido ate o FIM DO MES CORRENTE (atrasado + este mes), pra
      // avulsa E parcela. Parcela futura pertence a projecao, nao ao "Voce deve".
      // Antes a lista descartava parcela ATRASADA (so contava a do mes exato) e
      // contava avulsa FUTURA — divergindo da pagina de detalhe da pessoa.
      if (new Date(e.date) > monthEnd) continue
      if (e.type === 'THEY_OWE_ME') theyOweMe += Number(e.amount)
      else                          iOweThem  += Number(e.amount)
    }

    // Soma o template recorrente so quando ainda NAO existe PersonEntry dele neste
    // mes (o processRecurringPersonEntries acima cria assim que o dayOfMonth passa)
    // — casado pela FK recurringEntryId, nao por heuristica de descricao/data.
    for (const r of templates.filter(r => r.isActive)) {
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
