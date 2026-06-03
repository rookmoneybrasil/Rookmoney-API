-- Add startDate to IncomeSource: defines when recurring income begins.
-- NULL = start from current month (existing behavior).
ALTER TABLE "IncomeSource" ADD COLUMN "startDate" TIMESTAMP(3);
