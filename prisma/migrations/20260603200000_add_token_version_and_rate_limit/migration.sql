-- Add tokenVersion to User for JWT revocation (IF NOT EXISTS = idempotent)
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- RateLimit table (IF NOT EXISTS — may already exist from migration 20260603100000)
CREATE TABLE IF NOT EXISTS "RateLimit" (
  "id"      TEXT         NOT NULL,
  "count"   INTEGER      NOT NULL DEFAULT 0,
  "resetAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RateLimit_resetAt_idx" ON "RateLimit"("resetAt");
