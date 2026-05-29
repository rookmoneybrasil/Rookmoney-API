-- Create Person table
CREATE TABLE IF NOT EXISTS "Person" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Person_userId_idx" ON "Person"("userId");

ALTER TABLE "Person" DROP CONSTRAINT IF EXISTS "Person_userId_fkey";
ALTER TABLE "Person" ADD CONSTRAINT "Person_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Create PersonEntry enum if not exists
DO $$ BEGIN
    CREATE TYPE "PersonEntryType" AS ENUM ('THEY_OWE_ME', 'I_OWE_THEM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Create PersonEntry table
CREATE TABLE IF NOT EXISTS "PersonEntry" (
    "id" TEXT NOT NULL,
    "type" "PersonEntryType" NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "isSettled" BOOLEAN NOT NULL DEFAULT false,
    "settledAt" TIMESTAMP(3),
    "notes" TEXT,
    "installmentTotal" INTEGER,
    "installmentCurrent" INTEGER,
    "installmentGroupId" TEXT,
    "settledTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "personId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "categoryId" TEXT,
    CONSTRAINT "PersonEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PersonEntry_personId_idx" ON "PersonEntry"("personId");
CREATE INDEX IF NOT EXISTS "PersonEntry_userId_idx" ON "PersonEntry"("userId");
CREATE INDEX IF NOT EXISTS "PersonEntry_installmentGroupId_idx" ON "PersonEntry"("installmentGroupId");

ALTER TABLE "PersonEntry" DROP CONSTRAINT IF EXISTS "PersonEntry_personId_fkey";
ALTER TABLE "PersonEntry" ADD CONSTRAINT "PersonEntry_personId_fkey"
    FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PersonEntry" DROP CONSTRAINT IF EXISTS "PersonEntry_userId_fkey";
ALTER TABLE "PersonEntry" ADD CONSTRAINT "PersonEntry_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add missing columns to Bill
ALTER TABLE "Bill" ADD COLUMN IF NOT EXISTS "paidAt" TIMESTAMP(3);
ALTER TABLE "Bill" ADD COLUMN IF NOT EXISTS "paidTransactionId" TEXT;
ALTER TABLE "Bill" ADD COLUMN IF NOT EXISTS "notes" TEXT;
ALTER TABLE "Bill" ADD COLUMN IF NOT EXISTS "isRecurring" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Bill" ADD COLUMN IF NOT EXISTS "installmentTotal" INTEGER;
ALTER TABLE "Bill" ADD COLUMN IF NOT EXISTS "installmentCurrent" INTEGER;
ALTER TABLE "Bill" ADD COLUMN IF NOT EXISTS "installmentGroupId" TEXT;
ALTER TABLE "Bill" ADD COLUMN IF NOT EXISTS "categoryId" TEXT;

-- Add missing columns to IncomeSource
ALTER TABLE "IncomeSource" ADD COLUMN IF NOT EXISTS "notes" TEXT;
ALTER TABLE "IncomeSource" ADD COLUMN IF NOT EXISTS "categoryId" TEXT;

-- Add missing columns to RecurringTransaction
ALTER TABLE "RecurringTransaction" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "RecurringTransaction" ADD COLUMN IF NOT EXISTS "lastAutoMonth" TEXT;

-- Add missing columns to Goal
ALTER TABLE "Goal" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "Goal" ADD COLUMN IF NOT EXISTS "icon" TEXT;
ALTER TABLE "Goal" ADD COLUMN IF NOT EXISTS "color" TEXT;
ALTER TABLE "Goal" ADD COLUMN IF NOT EXISTS "isCompleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Goal" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);

-- Add missing columns to User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "plan" TEXT NOT NULL DEFAULT 'FREE';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isAdmin" BOOLEAN NOT NULL DEFAULT false;
