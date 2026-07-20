-- Remove o conceito duplicado "Transacao recorrente" (pagina /recurring, que
-- nunca esteve em nenhum menu). Contas Fixas (RecurringBill) cobrem a despesa
-- recorrente e Rendas (IncomeSource) cobrem a receita recorrente.
--
-- A conversao acontece AQUI, dentro da migration de schema, e nao em
-- data-migrations.ts: o Railway roda `prisma migrate deploy` no BUILD e as data
-- migrations so rodam no startup do servidor — ou seja, DEPOIS. Converter la
-- encontraria a tabela ja dropada. Aqui e atomico e na ordem certa.
--
-- Se nao houver nenhuma linha (o esperado), os dois INSERTs sao no-op.

-- Despesa recorrente -> Conta Fixa
-- Perde o debito automatico: passa a exigir clicar Pagar todo mes (decisao do dono).
INSERT INTO "RecurringBill" ("id", "name", "amount", "dayOfMonth", "isActive", "lastAutoMonth", "notes", "createdAt", "updatedAt", "userId", "categoryId")
SELECT
  md5(random()::text || clock_timestamp()::text || rt."id"),
  rt."name",
  rt."amount",
  COALESCE(rt."dayOfMonth", 1),
  rt."isActive",
  rt."lastAutoMonth",
  rt."description",
  rt."createdAt",
  rt."updatedAt",
  rt."userId",
  rt."categoryId"
FROM "RecurringTransaction" rt
WHERE rt."type" = 'EXPENSE';

-- Receita recorrente -> Renda recorrente
INSERT INTO "IncomeSource" ("id", "name", "type", "amount", "isRecurring", "dayOfMonth", "lastAutoPayMonth", "notes", "createdAt", "updatedAt", "userId", "categoryId")
SELECT
  md5(random()::text || clock_timestamp()::text || rt."id"),
  rt."name",
  'OTHER',
  rt."amount",
  rt."isActive",
  rt."dayOfMonth",
  rt."lastAutoMonth",
  rt."description",
  rt."createdAt",
  rt."updatedAt",
  rt."userId",
  rt."categoryId"
FROM "RecurringTransaction" rt
WHERE rt."type" = 'INCOME';

-- DropTable
DROP TABLE "RecurringTransaction";
