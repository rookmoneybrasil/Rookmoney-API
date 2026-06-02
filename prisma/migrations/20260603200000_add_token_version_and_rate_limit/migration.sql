-- Add tokenVersion to User for JWT revocation
ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- RateLimit table for persistent rate limiting
CREATE TABLE "RateLimit" (
  "id"      TEXT         NOT NULL,
  "count"   INTEGER      NOT NULL DEFAULT 0,
  "resetAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RateLimit_resetAt_idx" ON "RateLimit"("resetAt");
