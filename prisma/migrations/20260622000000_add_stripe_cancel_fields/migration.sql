ALTER TABLE "User" ADD COLUMN "stripeCancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "stripeCurrentPeriodEnd" TIMESTAMP(3);
