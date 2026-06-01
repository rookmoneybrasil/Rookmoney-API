ALTER TABLE "User"
  ADD COLUMN "notifBillReminder"  BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "notifCategoryLimit" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "notifMonthlyEmail"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "currency"           TEXT    NOT NULL DEFAULT 'BRL',
  ADD COLUMN "dateFormat"         TEXT    NOT NULL DEFAULT 'dd/MM/yyyy';
