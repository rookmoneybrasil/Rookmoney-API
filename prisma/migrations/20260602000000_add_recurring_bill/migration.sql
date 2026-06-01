-- RecurringBill template model
CREATE TABLE "RecurringBill" (
  "id"            TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "amount"        DECIMAL(12,2) NOT NULL,
  "dayOfMonth"    INTEGER NOT NULL,
  "isActive"      BOOLEAN NOT NULL DEFAULT true,
  "lastAutoMonth" TEXT,
  "notes"         TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "userId"        TEXT NOT NULL,
  "categoryId"    TEXT,
  CONSTRAINT "RecurringBill_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "RecurringBill"
  ADD CONSTRAINT "RecurringBill_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "RecurringBill_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "RecurringBill_userId_idx" ON "RecurringBill"("userId");

-- Add recurringBillId to Bill
ALTER TABLE "Bill"
  ADD COLUMN "recurringBillId" TEXT;

ALTER TABLE "Bill"
  ADD CONSTRAINT "Bill_recurringBillId_fkey"
    FOREIGN KEY ("recurringBillId") REFERENCES "RecurringBill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Bill_recurringBillId_idx" ON "Bill"("recurringBillId");
