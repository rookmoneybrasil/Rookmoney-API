import { PluggyClient } from 'pluggy-sdk'

function getClient(): PluggyClient {
  const clientId     = process.env.PLUGGY_CLIENT_ID
  const clientSecret = process.env.PLUGGY_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('Pluggy não configurado (PLUGGY_CLIENT_ID / PLUGGY_CLIENT_SECRET)')
  return new PluggyClient({ clientId, clientSecret })
}

// ─── Connect Token ───────────────────────────────────────────────────────────

export async function createConnectToken(userId?: string): Promise<string> {
  const pluggy = getClient()
  // Passing clientUserId links the connect session to a user in Pluggy's dashboard
  const result = await pluggy.createConnectToken(undefined, userId ? { clientUserId: userId } : undefined)
  return result.accessToken
}

// ─── Item ────────────────────────────────────────────────────────────────────

export async function fetchItem(itemId: string) {
  return getClient().fetchItem(itemId)
}

// ─── Accounts ────────────────────────────────────────────────────────────────

export async function fetchAccounts(itemId: string) {
  const res = await getClient().fetchAccounts(itemId)
  return res.results ?? []
}

// ─── Boletos / Transactions ──────────────────────────────────────────────────

export async function fetchBoletos(itemId: string) {
  const accounts = await fetchAccounts(itemId)
  const pluggy   = getClient()

  const now  = new Date()
  const from = new Date(now); from.setDate(from.getDate() - 7)
  const to   = new Date(now); to.setDate(to.getDate() + 60)

  const results = await Promise.allSettled(
    accounts.map(acc =>
      pluggy.fetchTransactions(acc.id, {
        from:     from.toISOString().slice(0, 10),
        to:       to.toISOString().slice(0, 10),
        pageSize: 100,
      }).catch(() => ({ results: [] as unknown[], total: 0, totalPages: 0, page: 1 }))
    )
  )

  const all = results
    .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof pluggy.fetchTransactions>>> => r.status === 'fulfilled')
    .flatMap(r => r.value.results ?? [])

  // Keep transactions that look like boleto / scheduled payments
  return all.filter(tx =>
    (tx as { type?: string }).type === 'BOLETO' ||
    (tx as { paymentData?: { barCode?: string } }).paymentData?.barCode ||
    (tx.status === 'PENDING' && tx.amount < 0)
  )
}
