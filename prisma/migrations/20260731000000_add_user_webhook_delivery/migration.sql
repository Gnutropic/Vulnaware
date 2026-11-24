-- @polsia:user-owned — Per-user DevSecOps webhook delivery ring buffer
-- (20 rows per user). Mirrors the additive-only posture of every prior
-- migration in this repo: pure CREATE TABLE + CREATE INDEX, no destructive
-- ops on existing data. The deliveries table IS the per-attempt audit
-- surface — no separate audit row is written per POST attempt.
--
-- CamelCase columns match the actual Prisma `db push` output and the rest of
-- prisma/migrations/*.sql. `polsia.toml` runs `prisma db push` at deploy, so
-- this .sql is parity-only with the repo's existing migration history.

CREATE TABLE "UserWebhookDelivery" (
    "id"           TEXT NOT NULL,
    "userId"       TEXT NOT NULL,
    "attemptedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "targetUrl"    TEXT NOT NULL,
    "payloadKind"  TEXT NOT NULL,
    "alertId"      TEXT,
    "responseCode" INTEGER,
    "latencyMs"    INTEGER NOT NULL,
    "snippet"      TEXT,

    CONSTRAINT "UserWebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserWebhookDelivery_userId_attemptedAt_idx" ON "UserWebhookDelivery"("userId", "attemptedAt" DESC);
