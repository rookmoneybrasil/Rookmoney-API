CREATE TABLE "Feedback" (
  "id"        TEXT NOT NULL,
  "type"      TEXT NOT NULL,
  "title"     TEXT NOT NULL,
  "body"      TEXT NOT NULL,
  "status"    TEXT NOT NULL DEFAULT 'open',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "userId"    TEXT NOT NULL,

  CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Feedback_userId_idx" ON "Feedback"("userId");
CREATE INDEX "Feedback_status_idx" ON "Feedback"("status");
