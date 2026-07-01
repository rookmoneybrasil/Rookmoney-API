-- Add Apple IAP transaction ID field
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "appleOriginalTransactionId" TEXT;
