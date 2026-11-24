-- @polsia:user-owned — Per-user DevSecOps webhook config (one row per user).
-- Mirrors the additive-only posture of every prior migration in this repo:
-- pure CREATE TABLE + CREATE UNIQUE + CREATE INDEX, no destructive ops on
-- existing data. `webhookUrl` is nullable so a user can wipe their saved
-- endpoint by PUT-ing `{ url: null }` from /account.
--
-- CamelCase columns match the actual Prisma `db push` output and the rest of
-- prisma/migrations/*.sql — no need to re-quote differently if `migrate diff`
-- is run later. `polsia.toml` here runs `prisma db push` at deploy, so this
-- .sql is parity-only with the repo's existing migration history.

CREATE TABLE "UserWebhookConfig" (
    "id"         TEXT NOT NULL,
    "userId"     TEXT NOT NULL,
    "webhookUrl" TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserWebhookConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserWebhookConfig_userId_key" ON "UserWebhookConfig"("userId");
CREATE INDEX "UserWebhookConfig_userId_idx" ON "UserWebhookConfig"("userId");
