-- @polsia:user-owned — Add reopen-stamp trio (reopened_at, reopened_by,
-- reopen_reason) on `Alert`. Mirrors the additive-only posture of the
-- close-stamp migration: ALTER TABLE … ADD COLUMN is forward-only and
-- never touches existing rows. No `ALTER TYPE` needed (the trio's
-- status transitions ride the existing `open / resolved / false_positive`
-- enum values; reopen flips back to `open`).
--
-- All three columns are nullable so existing rows survive
-- `prisma db push` without a backfill, and so the reopen path
-- (which stamps a fresh trio on a triage flip back to `open`)
-- lands cleanly.
--
-- Capped VARCHAR(500) on `reopen_reason` is a DB-side safety net so a
-- client that bypasses the route's zod body schema hits an INSERT-level
-- rejection rather than stamping a multi-column note. Mirrors the
-- `closingNote @db.VarChar(500)` and `falsePositiveReason @db.VarChar(500)`
-- posture declared in alerts.prisma.

ALTER TABLE "Alert" ADD COLUMN "reopened_at" TIMESTAMP(3);
ALTER TABLE "Alert" ADD COLUMN "reopened_by" TEXT;
ALTER TABLE "Alert" ADD COLUMN "reopen_reason" VARCHAR(500);
