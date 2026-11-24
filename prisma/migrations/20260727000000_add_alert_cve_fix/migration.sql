-- @polsia:user-owned — Add `AlertCveFix` table for the per-alert cached AI
-- suggested-fix steps. Mirrors the AlertCveSummary table shape: 1:1 keyed
-- on `alertId` with `onDelete: Cascade`, denormalised `teamId`, JSON-string
-- storage for the steps array, optional `model` / `promptVersion` mirrors,
-- and a `(teamId, generatedAt)` composite index for per-team cache-list
-- queries.
--
-- Timestamped strictly greater than the latest migration
-- (20260726000000_add_alert_owner) so a deploy picks it up after the
-- owner column is online. Additive only — no destructive ops on existing
-- tables — matches the Render `prisma migrate deploy` posture.

CREATE TABLE "AlertCveFix" (
    "alertId"       TEXT NOT NULL,
    "teamId"        TEXT NOT NULL,
    "fixStepsJson"  TEXT NOT NULL,
    "model"         TEXT,
    "promptVersion" TEXT,
    "generatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertCveFix_pkey" PRIMARY KEY ("alertId")
);

CREATE INDEX "AlertCveFix_teamId_generatedAt_idx" ON "AlertCveFix"("teamId", "generatedAt");

-- CASCADE so dropping the parent Alert evicts the cached fix row.
ALTER TABLE "AlertCveFix"
    ADD CONSTRAINT "AlertCveFix_alertId_fkey"
    FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;
