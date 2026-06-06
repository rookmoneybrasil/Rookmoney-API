-- CreateTable
CREATE TABLE "PluggyItem" (
    "id"            TEXT NOT NULL,
    "userId"        TEXT NOT NULL,
    "itemId"        TEXT NOT NULL,
    "connectorId"   INTEGER NOT NULL,
    "connectorName" TEXT NOT NULL,
    "status"        TEXT NOT NULL DEFAULT 'UPDATED',
    "lastSyncAt"    TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PluggyItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PluggyItem_itemId_key" ON "PluggyItem"("itemId");
CREATE INDEX "PluggyItem_userId_idx" ON "PluggyItem"("userId");

-- AddForeignKey
ALTER TABLE "PluggyItem" ADD CONSTRAINT "PluggyItem_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
