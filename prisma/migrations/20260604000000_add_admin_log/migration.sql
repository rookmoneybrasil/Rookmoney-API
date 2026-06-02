CREATE TABLE "AdminLog" (
  "id"        TEXT        NOT NULL,
  "action"    TEXT        NOT NULL,
  "targetId"  TEXT        NOT NULL,
  "details"   TEXT        NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminLog_targetId_idx" ON "AdminLog"("targetId");
CREATE INDEX "AdminLog_createdAt_idx" ON "AdminLog"("createdAt");
