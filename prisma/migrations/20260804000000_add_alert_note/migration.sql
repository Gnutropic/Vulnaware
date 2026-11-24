-- @polsia:user-owned — Add `AlertNote` table for the per-alert handoff-
-- note pane. Mirrors `20260728000000_add_alert_comment/migration.sql`
-- posture exactly: PK + composite index + cascade FK. `AlertNote` is the
-- lightweight shift-handoff row for one alert, flat 1:N
-- `Alert → AlertNote`.
--
-- Distinct from `AlertComment` (assignee-only update thread): this
-- surface is freely-readable AND freely-postable by any signed-in team
-- member, reverse-chrono newest-first, so SOC teams can hand context
-- off between shifts without claiming the CVE. Index shape stays
-- identical ((alertId, createdAt)) so a follow-up SELECT can swap
-- ASC↔DESC without a new composite.
--
-- Timestamped strictly greater than the latest migration
-- (20260803000000_add_alert_remediated) so a deploy that runs
-- `migrate deploy` picks it up last. Additive only — no destructive
-- ops on existing tables. `polsia.toml` here runs `prisma db push` at
-- deploy, so this .sql is parity-only with the repo's existing
-- migration history.

CREATE TABLE "AlertNote" (
    "id"           TEXT NOT NULL,
    "alertId"      TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "body"         TEXT NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AlertNote_alertId_createdAt_idx" ON "AlertNote"("alertId", "createdAt");

-- CASCADE so dropping the parent Alert evicts its handoff thread.
ALTER TABLE "AlertNote"
    ADD CONSTRAINT "AlertNote_alertId_fkey"
    FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;
