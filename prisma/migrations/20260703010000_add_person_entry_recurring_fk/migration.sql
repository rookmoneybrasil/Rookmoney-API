-- Add recurringEntryId to PersonEntry (FK to PersonEntryRecurring, mirrors Bill.recurringBillId)
ALTER TABLE "PersonEntry"
  ADD COLUMN "recurringEntryId" TEXT,
  ADD COLUMN "recurringMonth" TEXT;

ALTER TABLE "PersonEntry"
  ADD CONSTRAINT "PersonEntry_recurringEntryId_fkey"
    FOREIGN KEY ("recurringEntryId") REFERENCES "PersonEntryRecurring"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "PersonEntry_recurringEntryId_idx" ON "PersonEntry"("recurringEntryId");

-- Postgres treats NULL as distinct in unique constraints, so this only ever
-- rejects two rows that both have the SAME non-null recurringEntryId AND
-- recurringMonth — i.e. it stops a race from creating two entries for the
-- same recurring template in the same month. Rows with no recurringEntryId
-- (the vast majority of PersonEntry) are unaffected.
CREATE UNIQUE INDEX "PersonEntry_recurringEntryId_recurringMonth_key" ON "PersonEntry"("recurringEntryId", "recurringMonth");
