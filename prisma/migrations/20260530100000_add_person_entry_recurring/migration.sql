-- CreateTable PersonEntryRecurring
CREATE TABLE IF NOT EXISTS "PersonEntryRecurring" (
    "id"          TEXT NOT NULL,
    "type"        "PersonEntryType" NOT NULL,
    "description" TEXT NOT NULL,
    "amount"      DECIMAL(12,2) NOT NULL,
    "dayOfMonth"  INTEGER NOT NULL DEFAULT 1,
    "isActive"    BOOLEAN NOT NULL DEFAULT true,
    "notes"       TEXT,
    "lastMonth"   TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "personId"    TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "categoryId"  TEXT,
    CONSTRAINT "PersonEntryRecurring_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PersonEntryRecurring_userId_idx"   ON "PersonEntryRecurring"("userId");
CREATE INDEX IF NOT EXISTS "PersonEntryRecurring_personId_idx" ON "PersonEntryRecurring"("personId");

ALTER TABLE "PersonEntryRecurring" DROP CONSTRAINT IF EXISTS "PersonEntryRecurring_personId_fkey";
ALTER TABLE "PersonEntryRecurring" ADD CONSTRAINT "PersonEntryRecurring_personId_fkey"
    FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PersonEntryRecurring" DROP CONSTRAINT IF EXISTS "PersonEntryRecurring_userId_fkey";
ALTER TABLE "PersonEntryRecurring" ADD CONSTRAINT "PersonEntryRecurring_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
