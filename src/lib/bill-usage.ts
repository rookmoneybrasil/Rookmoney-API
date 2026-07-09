// Conta "contas conceituais" para efeito de limite de plano.
//
// Regra: uma conta PARCELADA conta como UMA conta só (não uma por parcela).
// Cada parcela individual é, conceitualmente, uma transação — não uma conta
// nova. Sem isso, um usuário FREE (limite 5) que cadastra um parcelamento de
// 12x já estoura o limite de cara e é mandado comprar o PRO indevidamente.
//
// Escopo: contas não pagas com vencimento no mês atual ou futuro (bills
// atrasadas de meses anteriores não penalizam o usuário — mesmo critério do
// resto do sistema).
//
// Aceita tanto o `db` global quanto um client de transação (`tx`).
// Assinaturas com `...args: any[]` para evitar incompatibilidade estrutural
// (contravariância) com os overloads complexos do PrismaClient/TransactionClient.
type BillCounter = {
  bill: {
    count: (...args: any[]) => Promise<number>
    groupBy: (...args: any[]) => Promise<{ installmentGroupId: string | null }[]>
  }
}

export async function countActiveBillUnits(client: BillCounter, userId: string): Promise<number> {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

  // Sequencial (não Promise.all): este helper também roda com um client de
  // transação interativa (`tx`) em bills/index.ts, e queries paralelas no mesmo
  // `tx` compartilham uma única conexão — o Prisma não garante isso (pode dar
  // "Transaction already closed"). São 2 counts indexados por userId, custo ínfimo.

  // Contas avulsas / recorrentes (sem grupo de parcelamento) — cada uma conta 1
  const singles = await client.bill.count({
    where: { userId, isPaid: false, dueDate: { gte: monthStart }, installmentGroupId: null },
  })
  // Grupos de parcelamento distintos com alguma parcela não paga no período — cada grupo conta 1
  const groups = await client.bill.groupBy({
    by: ['installmentGroupId'],
    where: { userId, isPaid: false, dueDate: { gte: monthStart }, installmentGroupId: { not: null } },
  })

  return singles + groups.length
}
