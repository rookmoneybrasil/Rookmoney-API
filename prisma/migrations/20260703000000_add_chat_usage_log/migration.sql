-- CreateTable
CREATE TABLE "ChatUsageLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(10,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatUsageLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatUsageLog_userId_createdAt_idx" ON "ChatUsageLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatUsageLog_createdAt_idx" ON "ChatUsageLog"("createdAt");

-- AddForeignKey
ALTER TABLE "ChatUsageLog" ADD CONSTRAINT "ChatUsageLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
