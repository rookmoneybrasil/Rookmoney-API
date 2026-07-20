import { db } from '@/lib/db'

// The account a generated Transaction lands in when none was explicitly chosen
// (pay a bill, receive income, settle a person debt, goal contribution, recurring,
// import…). SINGLE SOURCE — every Transaction.create must set accountId, otherwise
// the movement is invisible to account balances. Self-healing: if the user somehow
// has no account yet (brand-new user before the backfill migration ran), it creates
// the default "Carteira" so a payment never fails.
export async function resolveDefaultAccountId(userId: string): Promise<string> {
  // Precisa preferir conta ATIVA: os totais (tela Carteiras e dashboard) somam
  // so `!archived`, entao um lancamento que caisse numa conta arquivada sumiria
  // do saldo total. Arquivada e' o ultimo recurso, nunca a primeira escolha.
  const def = await db.account.findFirst({ where: { userId, isDefault: true, archived: false }, select: { id: true } })
  if (def) return def.id
  const active = await db.account.findFirst({ where: { userId, archived: false }, orderBy: { createdAt: 'asc' }, select: { id: true } })
  if (active) return active.id
  const any = await db.account.findFirst({ where: { userId }, orderBy: { createdAt: 'asc' }, select: { id: true } })
  if (any) return any.id
  const created = await db.account.create({
    data: { userId, name: 'Carteira', type: 'CASH', icon: '👛', color: '#22C55E', isDefault: true },
    select: { id: true },
  })
  return created.id
}

// Validates an accountId sent from a form: undefined = field not present (don't
// touch), null/'' = clear it, otherwise return the id only if the account really
// belongs to the user (prevents pointing a record at someone else's account).
export async function validateAccountId(userId: string, accountId?: string | null): Promise<string | null | undefined> {
  if (accountId === undefined) return undefined
  if (accountId === null || accountId === '') return null
  const acc = await db.account.findFirst({ where: { id: accountId, userId }, select: { id: true } })
  return acc?.id ?? null
}

// Total mostrado como "Saldo total" — soma so das contas ATIVAS (arquivada nao
// entra). Fonte unica: a tela de Carteiras e o card do dashboard consomem esta,
// nunca re-derivam (duas copias identicas hoje viram divergentes amanha).
export function sumActiveBalances(accounts: AccountWithBalance[]): number {
  return accounts.filter(a => !a.archived).reduce((s, a) => s + a.balance, 0)
}

export interface AccountWithBalance {
  id:             string
  name:           string
  type:           string
  icon:           string
  color:          string
  initialBalance: number
  isDefault:      boolean
  archived:       boolean
  balance:        number   // initialBalance + Σ income − Σ expense
}

// SINGLE SOURCE OF TRUTH for account balances. Balance is always COMPUTED from
// the account's initialBalance + the sum of its Transactions (never a stored
// column that drifts — the #1 bug class in this repo). Every surface that shows
// a balance (accounts screen, selector, dashboard) must call this, never
// re-derive it. Consumes one groupBy instead of N queries.
export async function computeAccountBalances(userId: string): Promise<AccountWithBalance[]> {
  const accounts = await db.account.findMany({
    where:   { userId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  })
  if (accounts.length === 0) return []

  const grouped = await db.transaction.groupBy({
    by:    ['accountId', 'type'],
    where: { userId, accountId: { not: null }, ignored: false },
    _sum:  { amount: true },
  })

  // accountId → net delta (income positive, expense negative)
  const delta = new Map<string, number>()
  for (const g of grouped) {
    if (!g.accountId) continue
    const sum = Number(g._sum.amount ?? 0)
    delta.set(g.accountId, (delta.get(g.accountId) ?? 0) + (g.type === 'INCOME' ? sum : -sum))
  }

  return accounts.map((a) => ({
    id:             a.id,
    name:           a.name,
    type:           a.type,
    icon:           a.icon,
    color:          a.color,
    initialBalance: Number(a.initialBalance),
    isDefault:      a.isDefault,
    archived:       a.archived,
    balance:        Number(a.initialBalance) + (delta.get(a.id) ?? 0),
  }))
}
