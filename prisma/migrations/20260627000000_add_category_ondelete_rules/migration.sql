-- Transaction: categoryId required → RESTRICT (prevent deleting category if transactions reference it)
ALTER TABLE "Transaction" DROP CONSTRAINT IF EXISTS "Transaction_categoryId_fkey";
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RecurringTransaction: categoryId required → RESTRICT
ALTER TABLE "RecurringTransaction" DROP CONSTRAINT IF EXISTS "RecurringTransaction_categoryId_fkey";
ALTER TABLE "RecurringTransaction" ADD CONSTRAINT "RecurringTransaction_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- IncomeSource: categoryId optional → SET NULL
ALTER TABLE "IncomeSource" DROP CONSTRAINT IF EXISTS "IncomeSource_categoryId_fkey";
ALTER TABLE "IncomeSource" ADD CONSTRAINT "IncomeSource_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Bill: categoryId optional → SET NULL
ALTER TABLE "Bill" DROP CONSTRAINT IF EXISTS "Bill_categoryId_fkey";
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RecurringBill: categoryId optional → SET NULL
ALTER TABLE "RecurringBill" DROP CONSTRAINT IF EXISTS "RecurringBill_categoryId_fkey";
ALTER TABLE "RecurringBill" ADD CONSTRAINT "RecurringBill_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- PersonEntryRecurring: categoryId optional → SET NULL
ALTER TABLE "PersonEntryRecurring" DROP CONSTRAINT IF EXISTS "PersonEntryRecurring_categoryId_fkey";
ALTER TABLE "PersonEntryRecurring" ADD CONSTRAINT "PersonEntryRecurring_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- PersonEntry: categoryId optional → SET NULL
ALTER TABLE "PersonEntry" DROP CONSTRAINT IF EXISTS "PersonEntry_categoryId_fkey";
ALTER TABLE "PersonEntry" ADD CONSTRAINT "PersonEntry_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
