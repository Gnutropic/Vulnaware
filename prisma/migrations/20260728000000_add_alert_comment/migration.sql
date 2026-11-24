-- @polsia:user-owned — Add `AlertComment` table for the per-alert update-
-- note thread. Mirrors `20260727000000_add_alert_cve_fix/migration.sql`
-- posture exactly: PK + composite index + cascade FK. `AlertComment` is
-- the per-assignee note row for one alert, flat 1:N `Alert → AlertComment`.
--
-- Timestamped strictly greater than the latest migration
-- (20260727000000_add_alert_cve_fix) so a deploy that runs `migrate
-- deploy` picks it up last. Additive only — no destructive ops on
-- existing tables. `polsia.toml` here runs `prisma db push` at deploy,
-- so this .sql is parity-only with the repo's existing migration history.

CREATE TABLE "AlertComment" (
    "id"        TEXT NOT NULL,
    "alertId"   TEXT NOT NULL,
    "authorId"  TEXT NOT NULL,
    "body"      TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertComment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AlertComment_alertId_createdAt_idx" ON "AlertComment"("alertId", "createdAt");

-- CASCADE so dropping the parent Alert evicts its note thread.
ALTER TABLE "AlertComment"
    ADD CONSTRAINT "AlertComment_alertId_fkey"
    FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;
