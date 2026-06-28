-- AlterTable
ALTER TABLE "User" ADD COLUMN "lastDripEmailDay" INTEGER,
ADD COLUMN "lastInactivityEmail" TIMESTAMP(3),
ADD COLUMN "lastPromoEmailDay" INTEGER;
