-- Add recurringMonth ("YYYY-MM") to Bill + a unique on (recurringBillId,
-- recurringMonth) so the self-healing generator can't create two bills for the
-- same template+month under a race (mirrors PersonEntry). Existing bills keep
-- recurringMonth = NULL; Postgres treats NULLs as distinct, so no conflict with
-- current data (the generator only sets recurringMonth on new rows).
ALTER TABLE "Bill" ADD COLUMN "recurringMonth" TEXT;
CREATE UNIQUE INDEX "Bill_recurringBillId_recurringMonth_key" ON "Bill"("recurringBillId", "recurringMonth");
