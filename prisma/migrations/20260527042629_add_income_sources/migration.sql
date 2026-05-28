-- CreateEnum
CREATE TYPE "IncomeSourceType" AS ENUM ('EMPLOYMENT', 'FREELANCE', 'RENTAL', 'OTHER');

-- CreateTable
CREATE TABLE "IncomeSource" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "IncomeSourceType" NOT NULL DEFAULT 'EMPLOYMENT',
    "amount" DECIMAL(12,2) NOT NULL,
    "isRecurring" BOOLEAN NOT NULL DEFAULT true,
    "dayOfMonth" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "IncomeSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IncomeSource_userId_idx" ON "IncomeSource"("userId");

-- AddForeignKey
ALTER TABLE "IncomeSource" ADD CONSTRAINT "IncomeSource_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
