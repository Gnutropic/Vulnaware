-- @polsia:user-owned — Add close-stamp trio (closed_at, closed_by,
-- closing_note) on `Alert`. Mirrors the additive-only posture of the FP
-- migration: ALTER TABLE … ADD COLUMN is forward-only and never touches
-- existing rows. Note: `resolved` is already in the `AlertStatus` enum
-- so no ALTER TYPE is needed.
--
-- All three columns are nullable so existing rows survive
-- `prisma db push` without a backfill, and so the reopen path (which
-- clears the trio) lands cleanly.
--
-- capped VARCHAR(500) on `closing_note` is a DB-side safety net so a
-- client that bypasses the route's zod body schema hits an INSERT-level
-- rejection rather than stamping a multi-column note. Mirrors the
-- `falsePositiveReason @db.VarChar(500)` posture declared in alerts.prisma.

ALTER TABLE "Alert" ADD COLUMN "closed_at" TIMESTAMP(3);
ALTER TABLE "Alert" ADD COLUMN "closed_by" TEXT;
ALTER TABLE "Alert" ADD COLUMN "closing_note" VARCHAR(500);
