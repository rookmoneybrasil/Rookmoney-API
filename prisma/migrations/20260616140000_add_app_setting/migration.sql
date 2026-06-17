CREATE TABLE "AppSetting" (
  "key"       TEXT NOT NULL,
  "value"     TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

INSERT INTO "AppSetting" ("key", "value", "updatedAt") VALUES
  ('churn_alert_threshold', '5',                          NOW()),
  ('admin_alert_email',     'viniguilherme013@gmail.com', NOW())
ON CONFLICT ("key") DO NOTHING;
