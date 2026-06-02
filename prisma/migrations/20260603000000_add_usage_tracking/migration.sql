ALTER TABLE "User"
  ADD COLUMN "chatUsageMonth"    TEXT,
  ADD COLUMN "chatUsageCount"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "scannerUsageMonth" TEXT,
  ADD COLUMN "scannerUsageCount" INTEGER NOT NULL DEFAULT 0;
