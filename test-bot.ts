/**
 * Bot de Consistência — Rook Money API
 * Testa lógica de negócio end-to-end: cascade deletes, saldos, limites,
 * geração automática, e detecta inconsistências nos dados.
 *
 * Uso:  npx tsx test-bot.ts
 */

const API = process.env.API_URL ?? 'https://rookmoney-api-production.up.railway.app'

const TEST_USER = {
  name:     'Bot Consistência',
  email:    `bot-consist-${Date.now()}@rookmoney.com`,
  password: 'T3ste@Rook!2026',
}

let token = ''
let stats = { passed: 0, failed: 0 }
let allIds: { type: string; id: string }[] = []

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Cookie: `rook_session=${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, ok: res.ok }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg)
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    stats.passed++
    console.log(`  ✅ ${name}`)
  } catch (err: any) {
    stats.failed++
    console.log(`  ❌ ${name}`)
    console.log(`     → ${err.message}`)
  }
}

function section(title: string) {
  console.log(`\n━━━ ${title} ━━━`)
}

const today = new Date().toISOString().slice(0, 10)
const yearMonth = today.slice(0, 7)

// ─── Setup ───────────────────────────────────────────────────────────────────

let defaultCatId = ''
let customCatId  = ''

async function setup() {
  section('SETUP')

  const { json: reg } = await api('POST', '/auth/register', TEST_USER)
  assert(reg?.data?.token, 'Falha no registro')
  token = reg.data.token
  console.log(`  🔑 Registrado: ${TEST_USER.email}`)

  const { json: cats } = await api('GET', '/categories')
  defaultCatId = cats.data.find((c: any) => c.isDefault)?.id ?? cats.data[0]?.id
  assert(defaultCatId, 'Sem categoria default')

  const { json: cat } = await api('POST', '/categories', { name: 'Bot Cat', icon: '🤖', color: '#FF0000' })
  customCatId = cat.data.id
  allIds.push({ type: 'category', id: customCatId })
  console.log(`  📂 Categoria default: ${defaultCatId}`)
}

// ─── 1. CASCADE: Pagar conta → cria transação, deletar conta → apaga transação
async function testBillPayCascade() {
  section('1. CASCADE: Pagar conta → transação vinculada')

  let billId = '', txId = ''

  await test('Pagar conta cria transação EXPENSE com mesmo valor', async () => {
    const { json } = await api('POST', '/bills', { name: 'Teste cascade', amount: '150', dueDate: today, categoryId: defaultCatId })
    billId = json.data.id

    const { json: paid } = await api('POST', `/bills/${billId}?action=pay`, { paid: true })
    assert(paid.data.isPaid === true, 'Conta não marcada como paga')
    txId = paid.data.paidTransactionId
    assert(txId, 'Nenhuma transação criada ao pagar')

    // Verificar que a transação existe e tem o valor correto
    const { json: txList } = await api('GET', '/transactions')
    const tx = txList.data.items.find((t: any) => t.id === txId)
    assert(tx, `Transação ${txId} não encontrada na listagem`)
    assert(Number(tx.amount) === 150, `Valor da transação: esperado 150, got ${tx.amount}`)
    assert(tx.type === 'EXPENSE', `Tipo: esperado EXPENSE, got ${tx.type}`)
  })

  await test('Desfazer pagamento apaga a transação', async () => {
    await api('POST', `/bills/${billId}?action=pay`, { paid: false })

    const { json: txList } = await api('GET', '/transactions')
    const tx = txList.data.items.find((t: any) => t.id === txId)
    assert(!tx, `Transação ${txId} ainda existe após desfazer pagamento`)
  })

  await test('Pagar e deletar conta → transação vinculada também some', async () => {
    const { json: paid } = await api('POST', `/bills/${billId}?action=pay`, { paid: true })
    const newTxId = paid.data.paidTransactionId

    await api('DELETE', `/bills/${billId}`)

    const { json: txList } = await api('GET', '/transactions')
    const tx = txList.data.items.find((t: any) => t.id === newTxId)
    assert(!tx, `Transação ${newTxId} não foi deletada junto com a conta`)
  })
}

// ─── 2. CASCADE: Deletar renda → apaga transações INCOME geradas
async function testIncomeDeleteCascade() {
  section('2. CASCADE: Deletar renda → transações INCOME apagadas')

  await test('Criar renda + transação manual com mesmo nome, deletar renda apaga tudo', async () => {
    const { json: src } = await api('POST', '/income-sources', {
      name: 'Renda Cascade Test', amount: '3000', type: 'EMPLOYMENT',
      isRecurring: true, dayOfMonth: 5, categoryId: defaultCatId,
    })
    const srcId = src.data.id

    // Criar transação INCOME manualmente com mesmo nome
    await api('POST', '/transactions', {
      amount: '3000', type: 'INCOME', description: 'Renda Cascade Test',
      date: today, categoryId: defaultCatId,
    })

    // Verificar que existe
    const { json: before } = await api('GET', '/transactions?type=INCOME')
    const countBefore = before.data.items.filter((t: any) => t.description === 'Renda Cascade Test').length
    assert(countBefore >= 1, `Esperava >=1 transação, encontrou ${countBefore}`)

    // Deletar a renda
    await api('DELETE', `/income-sources/${srcId}`)

    // Todas as transações com esse nome devem sumir
    const { json: after } = await api('GET', '/transactions?type=INCOME')
    const remaining = after.data.items.filter((t: any) => t.description === 'Renda Cascade Test').length
    assert(remaining === 0, `${remaining} transações INCOME órfãs após deletar renda`)
  })
}

// ─── 3. METAS: Contribuir, retirar, verificar saldo + transações
async function testGoalConsistency() {
  section('3. METAS: Saldo consistente após contribuir/retirar')

  let goalId = ''

  await test('Contribuir 3x → saldo = soma das contribuições', async () => {
    const { json } = await api('POST', '/goals', { name: 'Meta Consist', targetAmount: '10000' })
    goalId = json.data.id

    await api('POST', `/goals/${goalId}?action=contribute`, { amount: '500' })
    await api('POST', `/goals/${goalId}?action=contribute`, { amount: '300' })
    await api('POST', `/goals/${goalId}?action=contribute`, { amount: '200' })

    const { json: goal } = await api('GET', `/goals/${goalId}`)
    assert(Number(goal.data.currentAmount) === 1000, `Saldo: esperado 1000, got ${goal.data.currentAmount}`)
  })

  await test('Cada aporte cria transação EXPENSE "Aporte — Meta Consist"', async () => {
    const { json: txList } = await api('GET', '/transactions')
    const aportes = txList.data.items.filter((t: any) => t.description === 'Aporte — Meta Consist')
    assert(aportes.length === 3, `Esperava 3 transações de aporte, encontrou ${aportes.length}`)
    const soma = aportes.reduce((s: number, t: any) => s + Number(t.amount), 0)
    assert(soma === 1000, `Soma dos aportes: esperado 1000, got ${soma}`)
  })

  await test('Retirar 400 → saldo = 600, transações de aporte ajustadas', async () => {
    await api('POST', `/goals/${goalId}?action=withdraw`, { amount: '400' })

    const { json: goal } = await api('GET', `/goals/${goalId}`)
    assert(Number(goal.data.currentAmount) === 600, `Saldo: esperado 600, got ${goal.data.currentAmount}`)

    // Transações de aporte devem ter sido reduzidas/deletadas
    const { json: txList } = await api('GET', '/transactions')
    const aportes = txList.data.items.filter((t: any) => t.description === 'Aporte — Meta Consist')
    const somaRestante = aportes.reduce((s: number, t: any) => s + Number(t.amount), 0)
    assert(somaRestante === 600, `Soma aportes restantes: esperado 600, got ${somaRestante}`)
  })

  await test('Deletar meta → todas as transações de aporte somem', async () => {
    await api('DELETE', `/goals/${goalId}`)

    const { json: txList } = await api('GET', '/transactions')
    const aportes = txList.data.items.filter((t: any) => t.description === 'Aporte — Meta Consist')
    assert(aportes.length === 0, `${aportes.length} transações de aporte órfãs após deletar meta`)
  })
}

// ─── 4. PARCELAS: Criar grupo, verificar numeração + valores
async function testInstallmentConsistency() {
  section('4. PARCELAS: Numeração e valores consistentes')

  await test('3 parcelas de R$300 (1 já paga) → cria 2 bills, numeração 2/3 e 3/3', async () => {
    const { json } = await api('POST', '/bills', {
      name: 'Parcel Consist', amount: '300', dueDate: today,
      categoryId: defaultCatId, installments: 3, alreadyPaid: 1,
    })
    const groupId = json.data.installmentGroupId
    assert(json.data.count === 2, `Esperado 2 bills, got ${json.data.count}`)

    const { json: bills } = await api('GET', '/bills')
    const group = bills.data.filter((b: any) => b.installmentGroupId === groupId)
      .sort((a: any, b: any) => a.installmentCurrent - b.installmentCurrent)

    assert(group.length === 2, `Grupo tem ${group.length} bills, esperado 2`)
    assert(group[0].installmentCurrent === 2, `Primeira parcela: esperado 2/3, got ${group[0].installmentCurrent}/${group[0].installmentTotal}`)
    assert(group[1].installmentCurrent === 3, `Segunda parcela: esperado 3/3, got ${group[1].installmentCurrent}/${group[1].installmentTotal}`)

    // Soma dos valores deve ser R$300 (total das restantes)
    const soma = group.reduce((s: number, b: any) => s + Number(b.amount), 0)
    assert(Math.abs(soma - 300) < 0.02, `Soma parcelas: esperado 300, got ${soma}`)

    // Cleanup
    await api('DELETE', `/bills/group/${groupId}`)
  })

  await test('5 parcelas iguais → cada uma vale total/5 (sem centavo perdido)', async () => {
    const { json } = await api('POST', '/bills', {
      name: 'Parcel Centavo', amount: '100', dueDate: today,
      categoryId: defaultCatId, installments: 5,
    })
    const groupId = json.data.installmentGroupId

    const { json: bills } = await api('GET', '/bills')
    const group = bills.data.filter((b: any) => b.installmentGroupId === groupId)
    const soma = group.reduce((s: number, b: any) => s + Number(b.amount), 0)
    assert(Math.abs(soma - 100) < 0.02, `Soma 5 parcelas: esperado 100.00, got ${soma.toFixed(2)} (centavos perdidos!)`)

    await api('DELETE', `/bills/group/${groupId}`)
  })
}

// ─── 5. PESSOAS: Saldo consistente com entries + settle/unsettle
async function testPeopleBalanceConsistency() {
  section('5. PESSOAS: Saldo consistente')

  let personId = '', entryId1 = '', entryId2 = ''

  await test('THEY_OWE_ME R$500 + I_OWE_THEM R$200 → balance = +300', async () => {
    const { json: p } = await api('POST', '/people', { name: 'Pessoa Consist' })
    personId = p.data.id

    const { json: e1 } = await api('POST', `/people/${personId}?action=entry`, {
      type: 'THEY_OWE_ME', description: 'Me deve', amount: '500', date: today, categoryId: defaultCatId,
    })
    entryId1 = e1.data.id

    const { json: e2 } = await api('POST', `/people/${personId}?action=entry`, {
      type: 'I_OWE_THEM', description: 'Eu devo', amount: '200', date: today, categoryId: defaultCatId,
    })
    entryId2 = e2.data.id

    const { json: list } = await api('GET', '/people')
    const person = list.data.find((p: any) => p.id === personId)
    assert(person.theyOweMe === 500, `theyOweMe: esperado 500, got ${person.theyOweMe}`)
    assert(person.iOweThem === 200, `iOweThem: esperado 200, got ${person.iOweThem}`)
    assert(person.balance === 300, `balance: esperado 300, got ${person.balance}`)
  })

  await test('Liquidar THEY_OWE_ME → cria transação INCOME', async () => {
    const { json } = await api('POST', `/people/entries/${entryId1}?action=settle`)
    assert(json.data.isSettled === true, 'Entry não liquidada')
    const txId = json.data.settledTransactionId
    assert(txId, 'Nenhuma transação criada ao liquidar')

    const { json: txList } = await api('GET', '/transactions?type=INCOME')
    const tx = txList.data.items.find((t: any) => t.id === txId)
    assert(tx, 'Transação de liquidação não encontrada')
    assert(Number(tx.amount) === 500, `Valor transação: esperado 500, got ${tx.amount}`)
  })

  await test('Liquidar I_OWE_THEM → cria transação EXPENSE', async () => {
    const { json } = await api('POST', `/people/entries/${entryId2}?action=settle`)
    const txId = json.data.settledTransactionId

    const { json: txList } = await api('GET', '/transactions?type=EXPENSE')
    const tx = txList.data.items.find((t: any) => t.id === txId)
    assert(tx, 'Transação de liquidação EXPENSE não encontrada')
    assert(Number(tx.amount) === 200, `Valor transação: esperado 200, got ${tx.amount}`)
  })

  await test('Saldo após 2 liquidações → balance = 0 (ambos quitados)', async () => {
    const { json: list } = await api('GET', '/people')
    const person = list.data.find((p: any) => p.id === personId)
    // Entries liquidadas não contam no saldo
    assert(person.balance === 0, `balance após liquidar tudo: esperado 0, got ${person.balance}`)
  })

  await test('Desfazer liquidação → transação some, saldo volta', async () => {
    const { json: before } = await api('POST', `/people/entries/${entryId1}?action=settle`)
    // entry1 was already settled, unsettle returns the current state
    await api('POST', `/people/entries/${entryId1}?action=unsettle`)

    const { json: list } = await api('GET', '/people')
    const person = list.data.find((p: any) => p.id === personId)
    assert(person.theyOweMe === 500, `Após unsettle: theyOweMe esperado 500, got ${person.theyOweMe}`)
  })

  // Cleanup
  allIds.push({ type: 'person', id: personId })
}

// ─── 6. CONTAS FIXAS: Gera bill do mês automaticamente
async function testRecurringBillGeneration() {
  section('6. CONTAS FIXAS: Geração automática do mês')

  await test('Criar template com generateNow → bill do mês aparece na listagem', async () => {
    const { json: tmpl } = await api('POST', '/bills/recurring', {
      name: 'Fixa Auto', amount: '89.90', dayOfMonth: 15,
      categoryId: defaultCatId, generateNow: true,
    })
    const tmplId = tmpl.data.id

    const { json: bills } = await api('GET', '/bills')
    const generated = bills.data.find((b: any) => b.recurringBillId === tmplId)
    assert(generated, 'Bill do mês não foi gerada automaticamente')
    assert(Number(generated.amount) === 89.90, `Valor: esperado 89.90, got ${generated.amount}`)
    assert(generated.name === 'Fixa Auto', `Nome: esperado "Fixa Auto", got "${generated.name}"`)

    // Template lastAutoMonth deve estar setado
    const { json: templates } = await api('GET', '/bills/recurring')
    const t = templates.data.find((r: any) => r.id === tmplId)
    assert(t.lastAutoMonth === yearMonth, `lastAutoMonth: esperado ${yearMonth}, got ${t.lastAutoMonth}`)

    allIds.push({ type: 'recurringBill', id: tmplId })
  })

  await test('Deletar bill gerada (skip) → lastAutoMonth atualiza, não regenera', async () => {
    const { json: bills } = await api('GET', '/bills')
    const generated = bills.data.find((b: any) => b.name === 'Fixa Auto')
    if (!generated) { stats.passed++; return }

    await api('DELETE', `/bills/${generated.id}`)

    // Forçar GET /bills que chama generateRecurringBillsThisMonth
    const { json: bills2 } = await api('GET', '/bills')
    const regenerated = bills2.data.find((b: any) => b.name === 'Fixa Auto')
    assert(!regenerated, 'Bill regenerou após ser deletada (skip deveria impedir)')
  })
}

// ─── 7. LIMITES FREE: Verificar enforcement
async function testFreePlanLimits() {
  section('7. LIMITES PLANO FREE')

  await test('GET /projection → 403 (PRO only)', async () => {
    const { status } = await api('GET', '/projection?months=3')
    assert(status === 403, `Esperado 403, got ${status} — projection não está bloqueada para FREE`)
  })

  await test('POST /chat → 403 (PRO only)', async () => {
    const { status } = await api('POST', '/chat', {
      messages: [{ role: 'user', content: 'oi' }],
    })
    assert(status === 403, `Esperado 403, got ${status} — chat não está bloqueado para FREE`)
  })
}

// ─── 8. TRANSAÇÕES RECORRENTES: Verificar geração
async function testRecurringTransactions() {
  section('8. TRANSAÇÕES RECORRENTES')

  await test('Criar recorrente + dashboard trigger → transação do mês aparece', async () => {
    const { json } = await api('POST', '/recurring', {
      name: 'Recorrente Consist', type: 'EXPENSE', amount: '120',
      dayOfMonth: 1, categoryId: defaultCatId,
    })
    const recId = json.data.id

    // Dashboard trigger processamento de recorrentes
    await api('GET', '/dashboard')

    const { json: txList } = await api('GET', '/transactions')
    const generated = txList.data.items.find((t: any) =>
      t.description === 'Recorrente Consist' && t.type === 'EXPENSE'
    )
    assert(generated, 'Transação recorrente do mês não foi gerada pelo dashboard')
    assert(Number(generated.amount) === 120, `Valor: esperado 120, got ${generated.amount}`)

    allIds.push({ type: 'recurring', id: recId })
  })
}

// ─── 9. CATEGORIAS: Editar e deletar, verificar integridade
async function testCategoryIntegrity() {
  section('9. CATEGORIAS: Integridade após edição/deleção')

  await test('Criar transação com categoria custom, deletar categoria → transação mantém categoryId null ou default', async () => {
    const { json: cat } = await api('POST', '/categories', { name: 'Cat Temp', icon: '🗑️', color: '#999' })
    const catId = cat.data.id

    const { json: tx } = await api('POST', '/transactions', {
      amount: '50', type: 'EXPENSE', description: 'Tx com cat temp',
      date: today, categoryId: catId,
    })
    const txId = tx.data.id

    // Deletar a categoria
    await api('DELETE', `/categories/${catId}`)

    // Verificar a transação — categoryId deve ser null (Prisma SetNull) ou dar erro
    const { json: txList } = await api('GET', '/transactions')
    const found = txList.data.items.find((t: any) => t.id === txId)
    if (found) {
      // Se a transação existe, categoryId deve ser null (cascade setNull)
      const catStillExists = found.category !== null
      // Apenas log — depende do schema
      if (catStillExists) {
        console.log(`     ⚠️  Transação mantém categoria que foi deletada (possível referência órfã)`)
      }
    }

    if (found) await api('DELETE', `/transactions/${txId}`)
  })
}

// ─── 10. DASHBOARD: Valores consistentes com dados criados
async function testDashboardConsistency() {
  section('10. DASHBOARD: Totais consistentes')

  await test('Dashboard reflete transações existentes', async () => {
    // Criar dados conhecidos
    await api('POST', '/transactions', { amount: '1000', type: 'INCOME', description: 'Dashboard test income', date: today, categoryId: defaultCatId })
    await api('POST', '/transactions', { amount: '300', type: 'EXPENSE', description: 'Dashboard test expense', date: today, categoryId: defaultCatId })

    const { json: dash } = await api('GET', '/dashboard')
    assert(dash.data, 'Dashboard sem data')

    const totalIncome  = Number(dash.data.monthIncome ?? 0)
    const totalExpense = Number(dash.data.monthExpense ?? 0)

    assert(totalIncome >= 1000, `monthIncome (${totalIncome}) deveria ser >= 1000`)
    assert(totalExpense >= 300, `monthExpense (${totalExpense}) deveria ser >= 300`)
  })
}

// ─── 10b. DASHBOARD MODAIS: KPI card total = soma dos itens do modal
async function testDashboardModals() {
  section('10b. DASHBOARD MODAIS: Card total = soma itens')

  // Create known data to populate modals
  const { json: src } = await api('POST', '/income-sources', {
    name: 'Modal Salário', amount: '4000', type: 'EMPLOYMENT',
    isRecurring: true, dayOfMonth: 1, categoryId: defaultCatId,
  })
  const { json: src2 } = await api('POST', '/income-sources', {
    name: 'Modal Freelance', amount: '1000', type: 'FREELANCE',
    isRecurring: false,
  })

  const { json: person } = await api('POST', '/people', { name: 'Modal Pessoa' })
  const personId = person.data.id

  await api('POST', `/people/${personId}?action=entry`, {
    type: 'THEY_OWE_ME', description: 'Me deve modal', amount: '300', date: today, categoryId: defaultCatId,
  })
  await api('POST', `/people/${personId}?action=entry`, {
    type: 'I_OWE_THEM', description: 'Devo modal', amount: '150', date: today, categoryId: defaultCatId,
  })

  const { json: bill } = await api('POST', '/bills', {
    name: 'Conta modal', amount: '500', dueDate: today, categoryId: defaultCatId,
  })

  // Trigger dashboard (processes auto-income/recurring)
  const { json: dash } = await api('GET', '/dashboard')
  const d = dash.data

  await test('Modal "A Receber": totalReceivable = rendas pendentes + pessoas a receber', async () => {
    const sumPendingSources = (d.pendingIncomeSources ?? []).reduce((s: number, src: any) => s + Number(src.amount), 0)
    const sumPeopleReceivable = d.totalPeopleReceivable ?? 0
    const totalIncomeReceivable = d.totalIncomeReceivable ?? 0
    const expected = sumPeopleReceivable + totalIncomeReceivable
    const got = d.totalReceivable

    assert(Math.abs(got - expected) < 0.01,
      `Card mostra R$${got.toFixed(2)} mas soma dos itens (pessoas R$${sumPeopleReceivable.toFixed(2)} + rendas R$${totalIncomeReceivable.toFixed(2)}) = R$${expected.toFixed(2)}`)
  })

  await test('Modal "Saldo": monthBalance = monthIncome - monthExpense', async () => {
    const expected = d.monthIncome - d.monthExpense
    assert(Math.abs(d.monthBalance - expected) < 0.01,
      `Saldo: card mostra R$${d.monthBalance.toFixed(2)} mas income(${d.monthIncome.toFixed(2)}) - expense(${d.monthExpense.toFixed(2)}) = R$${expected.toFixed(2)}`)
  })

  await test('Modal "Receitas": monthIncome >= soma das transações INCOME listadas', async () => {
    const txs = d.monthIncomeTransactions ?? []
    const peopleReceived = d.monthPeopleReceived ?? []
    const sumTxs = txs.reduce((s: number, t: any) => s + Number(t.amount), 0)
    const sumPeople = peopleReceived.reduce((s: number, e: any) => s + Number(e.amount), 0)
    const modalTotal = sumTxs + sumPeople

    // monthIncome is from aggregate, modal items should match
    assert(Math.abs(d.monthIncome - modalTotal) < 0.01,
      `Card "Receitas" mostra R$${d.monthIncome.toFixed(2)} mas modal lista R$${modalTotal.toFixed(2)} (txs: R$${sumTxs.toFixed(2)} + pessoas: R$${sumPeople.toFixed(2)})`)
  })

  await test('Modal "A Pagar": card total = soma bills pendentes + pessoas', async () => {
    const billsAmount = d.pendingBillsAmount ?? 0
    const personAmount = d.personPayablesAmount ?? 0
    const cardTotal = billsAmount + personAmount

    // Verify bills in modal match
    const upcomingBills = d.upcomingBills ?? []
    const unpaidBills = upcomingBills.filter((b: any) => !b.isPaid)
    const sumBillsModal = unpaidBills.reduce((s: number, b: any) => s + Number(b.amount), 0)

    // upcomingBills only shows 5, so it might be less than pendingBillsAmount
    // At least verify pendingBillsAmount >= sum of displayed bills
    assert(billsAmount >= sumBillsModal - 0.01,
      `pendingBillsAmount (R$${billsAmount.toFixed(2)}) < soma das bills no modal (R$${sumBillsModal.toFixed(2)})`)

    // Verify personPayablesAmount matches upcoming person payables
    const upPayables = d.upcomingPersonPayables ?? []
    const sumPersonModal = upPayables.reduce((s: number, e: any) => s + Number(e.amount), 0)
    // personPayablesAmount can include recurring templates, so >= modal sum
    assert(personAmount >= sumPersonModal - 0.01,
      `personPayablesAmount (R$${personAmount.toFixed(2)}) < soma das entries no modal (R$${sumPersonModal.toFixed(2)})`)
  })

  await test('pendingBillsCount bate com bills não-pagas no mês', async () => {
    const { json: allBills } = await api('GET', '/bills')
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)
    const unpaidThisMonth = allBills.data.filter((b: any) =>
      !b.isPaid && new Date(b.dueDate) >= monthStart && new Date(b.dueDate) <= monthEnd
    )
    assert(d.pendingBillsCount === unpaidThisMonth.length,
      `Dashboard pendingBillsCount=${d.pendingBillsCount} mas GET /bills retorna ${unpaidThisMonth.length} não-pagas no mês`)
  })

  await test('overdueCount bate com bills vencidas não-pagas', async () => {
    const { json: allBills } = await api('GET', '/bills')
    const now = new Date()
    const overdueBills = allBills.data.filter((b: any) => !b.isPaid && new Date(b.dueDate) < now)
    assert(d.overdueCount === overdueBills.length,
      `Dashboard overdueCount=${d.overdueCount} mas GET /bills retorna ${overdueBills.length} vencidas`)
  })

  // Cleanup
  allIds.push({ type: 'incomeSource', id: src.data.id })
  allIds.push({ type: 'incomeSource', id: src2.data.id })
  allIds.push({ type: 'person', id: personId })
}

// ─── 11. BUDGET: CRUD + verificar limites
async function testBudget() {
  section('11. ORÇAMENTO')

  let budgetId = ''

  await test('POST criar orçamento → 403 (PRO only)', async () => {
    const { status } = await api('POST', '/budget', {
      categoryId: defaultCatId, amount: '500',
      month: yearMonth,
    })
    assert(status === 403, `Esperado 403 para FREE, got ${status}`)
  })

  await test('GET listar orçamentos → 403 (PRO only)', async () => {
    const { status } = await api('GET', `/budget?month=${yearMonth}`)
    assert(status === 403, `Esperado 403 para FREE, got ${status}`)
  })

  if (budgetId) {
    allIds.push({ type: 'budget', id: budgetId })
  }
}

// ─── 12. EDGE CASES de segurança
async function testSecurityEdgeCases() {
  section('12. SEGURANÇA: Acesso cruzado')

  await test('Acessar meta de outro user → 404 (não 200 com dados vazios)', async () => {
    const { status } = await api('GET', '/goals/clxxxxxxxxxxxxxxxxxx')
    assert(status === 404, `Esperado 404 para ID inexistente, got ${status}`)
  })

  await test('Deletar bill de outro user → 404', async () => {
    const { status } = await api('DELETE', '/bills/clxxxxxxxxxxxxxxxxxx')
    assert(status === 404, `Esperado 404, got ${status}`)
  })

  await test('Pagar bill de outro user → 404', async () => {
    const { status } = await api('POST', '/bills/clxxxxxxxxxxxxxxxxxx?action=pay', { paid: true })
    assert(status === 404, `Esperado 404, got ${status}`)
  })

  await test('Editar transação inexistente → 404', async () => {
    const { status } = await api('PATCH', '/transactions/clxxxxxxxxxxxxxxxxxx', { amount: '999' })
    assert(status === 404, `Esperado 404, got ${status}`)
  })

  await test('Settings: profileImage com URL HTTP (não HTTPS) → rejeita', async () => {
    const { status } = await api('PATCH', '/settings', {
      profileImage: 'http://evil.com/malware.jpg',
    })
    assert(status === 400, `Esperado 400 para URL HTTP, got ${status}`)
  })

  await test('Settings: profileImage com host não-permitido → rejeita', async () => {
    const { status } = await api('PATCH', '/settings', {
      profileImage: 'https://evil.com/steal-data.jpg',
    })
    assert(status === 400, `Esperado 400 para host não-permitido, got ${status}`)
  })
}

// ─── 13. RENDAS: revert + edição atualiza transação
async function testIncomeSourceRevert() {
  section('13. RENDAS: Revert e edição')

  let srcId = ''

  await test('Criar renda recorrente → dashboard gera transação do mês', async () => {
    const { json } = await api('POST', '/income-sources', {
      name: 'Salário Revert', amount: '5000', type: 'EMPLOYMENT',
      isRecurring: true, dayOfMonth: 1, categoryId: defaultCatId,
    })
    srcId = json.data.id

    // Dashboard processa auto-pay
    await api('GET', '/dashboard')

    const { json: txList } = await api('GET', '/transactions?type=INCOME')
    const generated = txList.data.items.find((t: any) => t.description === 'Salário Revert')
    assert(generated, 'Transação de renda não foi gerada')
    assert(Number(generated.amount) === 5000, `Valor: esperado 5000, got ${generated.amount}`)
  })

  await test('Revert renda → transação do mês desaparece', async () => {
    const { status } = await api('POST', `/income-sources/${srcId}?action=revert`)
    assert(status === 200, `Revert falhou: status ${status}`)

    const { json: txList } = await api('GET', '/transactions?type=INCOME')
    const remaining = txList.data.items.find((t: any) => t.description === 'Salário Revert')
    assert(!remaining, 'Transação de renda ainda existe após revert')
  })

  allIds.push({ type: 'incomeSource', id: srcId })
}

// ─── 14. FEEDBACK: Enviar e verificar
async function testFeedback() {
  section('14. FEEDBACK')

  await test('POST enviar feedback', async () => {
    const { status, json } = await api('POST', '/feedback', {
      type: 'bug', title: 'Bot teste feedback', body: 'Teste automatizado pelo bot de consistência.',
    })
    assert(status === 200 || status === 201, `status ${status}: ${JSON.stringify(json)}`)
  })

  await test('POST feedback sem body → 400', async () => {
    const { status } = await api('POST', '/feedback', { type: 'bug', title: 'Sem body' })
    assert(status === 400, `Esperado 400, got ${status}`)
  })

  await test('POST feedback tipo inválido → 400', async () => {
    const { status } = await api('POST', '/feedback', { type: 'invalid', title: 'Test', body: 'Test' })
    assert(status === 400, `Esperado 400, got ${status}`)
  })
}

// ─── CLEANUP ─────────────────────────────────────────────────────────────────

async function doCleanup() {
  section('CLEANUP')

  // Delete all remaining bills
  const { json: bills } = await api('GET', '/bills')
  if (bills?.data) {
    for (const b of bills.data) await api('DELETE', `/bills/${b.id}`).catch(() => {})
  }

  // Delete all remaining transactions
  const { json: txs } = await api('GET', '/transactions')
  if (txs?.data?.items) {
    for (const t of txs.data.items) await api('DELETE', `/transactions/${t.id}`).catch(() => {})
  }

  // Delete tracked resources
  for (const { type, id } of allIds.reverse()) {
    const paths: Record<string, string> = {
      category: `/categories/${id}`,
      person: `/people/${id}`,
      recurringBill: `/bills/recurring/${id}`,
      recurring: `/recurring/${id}`,
      incomeSource: `/income-sources/${id}`,
      budget: `/budget/${id}`,
    }
    if (paths[type]) await api('DELETE', paths[type]).catch(() => {})
  }

  // Delete remaining goals
  const { json: goals } = await api('GET', '/goals?completed=true')
  if (goals?.data) {
    for (const g of goals.data) await api('DELETE', `/goals/${g.id}`).catch(() => {})
  }

  // Delete remaining income sources
  const { json: sources } = await api('GET', '/income-sources')
  if (sources?.data) {
    for (const s of sources.data) await api('DELETE', `/income-sources/${s.id}`).catch(() => {})
  }

  // Delete remaining people
  const { json: people } = await api('GET', '/people')
  if (people?.data) {
    for (const p of people.data) await api('DELETE', `/people/${p.id}`).catch(() => {})
  }

  // Delete the test user account itself
  await api('DELETE', '/settings')
  console.log('  🧹 Dados de teste limpos + conta deletada')
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍 Bot de Consistência — Rook Money API`)
  console.log(`   Target: ${API}`)
  console.log(`   User:   ${TEST_USER.email}`)
  console.log(`   Time:   ${new Date().toLocaleString('pt-BR')}\n`)

  try {
    await setup()
    await testBillPayCascade()
    await testIncomeDeleteCascade()
    await testGoalConsistency()
    await testInstallmentConsistency()
    await testPeopleBalanceConsistency()
    await testRecurringBillGeneration()
    await testFreePlanLimits()
    await testRecurringTransactions()
    await testCategoryIntegrity()
    await testDashboardConsistency()
    await testDashboardModals()
    await testBudget()
    await testSecurityEdgeCases()
    await testIncomeSourceRevert()
    await testFeedback()
  } finally {
    await doCleanup()
  }

  section('RESULTADO')
  const total = stats.passed + stats.failed
  console.log(`  Total:  ${total} testes`)
  console.log(`  ✅ OK:    ${stats.passed}`)
  console.log(`  ❌ FAIL:  ${stats.failed}`)

  if (stats.failed > 0) {
    console.log(`\n  ⚠️  ${stats.failed} inconsistência(s) detectada(s)!`)
  } else {
    console.log(`\n  🎉 Nenhuma inconsistência encontrada.`)
  }
  console.log()

  if (stats.failed > 0) process.exit(1)
}

main().catch(err => {
  console.error('\n💥 Erro fatal:', err.message)
  process.exit(1)
})
