-- AlterTable
ALTER TABLE "Bill" ADD COLUMN     "installmentCurrent" INTEGER,
ADD COLUMN     "installmentGroupId" TEXT,
ADD COLUMN     "installmentTotal" INTEGER;

-- CreateIndex
CREATE INDEX "Bill_installmentGroupId_idx" ON "Bill"("installmentGroupId");
