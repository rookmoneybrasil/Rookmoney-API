-- AlterTable
ALTER TABLE "Bill" ADD COLUMN "accountId" TEXT;
ALTER TABLE "IncomeSource" ADD COLUMN "accountId" TEXT;
ALTER TABLE "RecurringBill" ADD COLUMN "accountId" TEXT;

-- CreateIndex
CREATE INDEX "Bill_accountId_idx" ON "Bill"("accountId");
CREATE INDEX "IncomeSource_accountId_idx" ON "IncomeSource"("accountId");
CREATE INDEX "RecurringBill_accountId_idx" ON "RecurringBill"("accountId");

-- AddForeignKey
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IncomeSource" ADD CONSTRAINT "IncomeSource_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RecurringBill" ADD CONSTRAINT "RecurringBill_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
