-- Add startMonth ("YYYY-MM") to PersonEntryRecurring: the first month the
-- template should generate an entry for (derived from the "1ª data" the user
-- picked). NULL = legacy templates that start immediately.
ALTER TABLE "PersonEntryRecurring" ADD COLUMN "startMonth" TEXT;
