-- AlterTable
ALTER TABLE "IncomeSource" ADD COLUMN     "categoryId" TEXT,
ADD COLUMN     "lastAutoPayMonth" TEXT;

-- AddForeignKey
ALTER TABLE "IncomeSource" ADD CONSTRAINT "IncomeSource_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
