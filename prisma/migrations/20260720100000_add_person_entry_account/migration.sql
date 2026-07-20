-- AlterTable
ALTER TABLE "PersonEntry" ADD COLUMN "accountId" TEXT;
ALTER TABLE "PersonEntryRecurring" ADD COLUMN "accountId" TEXT;

-- CreateIndex
CREATE INDEX "PersonEntry_accountId_idx" ON "PersonEntry"("accountId");

-- AddForeignKey
ALTER TABLE "PersonEntry" ADD CONSTRAINT "PersonEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PersonEntryRecurring" ADD CONSTRAINT "PersonEntryRecurring_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
