-- @polsia:user-owned — Add `snoozedUntil` on `Alert`. Mirrors the
-- ADD COLUMN parity posture used by add_alert_remediated and the
-- close-stamp trio: ALTER TABLE … ADD COLUMN is forward-only and
-- never touches existing rows. The column is TIMESTAMP(3) (Prisma's
-- `DateTime` Postgres mapping) and nullable so existing rows
-- survive `prisma db push` without a backfill, and so the route's
-- { until: null } clear path lands cleanly on a previously-stamped
-- row.
--
-- The identifier is the camelCase `"snoozedUntil"` (no `@map` on the
-- Prisma schema, mirrors the live `remediatedAt`/`closedAt`/`reopenedAt`
-- shape and confirmed by the generated client's FieldRef payload). The
-- existing `@@index([teamId, snoozedUntil])` declared on the Prisma
-- model at alerts.prisma:211 is materialized here as the SQL-side
-- composite index that backs the (teamId, snoozedUntil) OR-arm scan
-- on /api/alerts.

ALTER TABLE "Alert" ADD COLUMN "snoozedUntil" TIMESTAMP(3);
CREATE INDEX "Alert_teamId_snoozedUntil_idx" ON "Alert"("teamId", "snoozedUntil");
