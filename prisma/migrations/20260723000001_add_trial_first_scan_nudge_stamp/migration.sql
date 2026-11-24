-- @polsia:user-owned — stamp column for the trial-first-scan nudge cron.
--
-- Nullable (no backfill needed): the cron also gates on the existence of
-- a TrialFunnelEvent with step='first_scan_triggered' for the owner, so
-- existing workspaces that already had a first scan won't be re-nudged
-- regardless of the stamp value. Idempotent under repeated `db push` once
-- this migration is recorded.

ALTER TABLE "TrialWorkspace"
    ADD COLUMN "lastFirstScanNudgeSentAt" TIMESTAMP(3) NULL;
