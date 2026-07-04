-- Add startMonth ("YYYY-MM") to RecurringBill: the first month the template
-- should generate a Bill for (derived from the "1ª data" the user picked).
-- NULL = legacy templates that start immediately.
ALTER TABLE "RecurringBill" ADD COLUMN "startMonth" TEXT;
