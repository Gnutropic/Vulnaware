-- @polsia:user-owned — Add `false_positive` to `AlertStatus` enum and a
-- `false_positive_reason` VARCHAR(500) column on `Alert`. Mirrors the
-- additive-only posture of every prior alert migration in this repo:
-- `ALTER TYPE ... ADD VALUE` and `ALTER TABLE ... ADD COLUMN` are both
-- forward-only and never touch existing rows.
--
-- Enum ordering: appended AFTER `resolved` so the Prisma ordinal stays
-- monotone (open=0, in_progress=1, resolved=2, false_positive=3).
-- Mirrors the sort comparator in src/lib/business/alerts-sort.ts so the
-- SQL `orderBy` branch and the in-app comparator agree on the rank —
-- a `false_positive` row never silently sinks to `MAX_SAFE_INTEGER`.
--
-- Column cap: VARCHAR(500) is a DB-side safety net so a malformed client
-- that bypasses the route handler's zod body schema (AlertFalsePositiveBody
-- z.string().trim().min(1).max(500)) hits an INSERT-level rejection rather
-- than stamping a multi-column reason. Nullable so existing rows survive
-- `prisma db push` without a backfill, and so a row re-opened from
-- `false_positive` back to `open` (route handler explicitly sets the
-- column to NULL) cleanly clears the suppression stamp.
--
-- `polsia.toml` here runs `prisma db push` at deploy, so this .sql is
-- parity-only with the repo's existing migration history.

ALTER TYPE "AlertStatus" ADD VALUE 'false_positive' AFTER 'resolved';
ALTER TABLE "Alert" ADD COLUMN "false_positive_reason" VARCHAR(500);
