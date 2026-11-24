-- @polsia:user-owned — Add `remediated_at` on `Alert`. Mirrors the
-- additive-only posture of the close-stamp + reopen-stamp migrations:
-- ALTER TABLE … ADD COLUMN is forward-only and never touches existing
-- rows. The column is TIMESTAMP(3) (Prisma's `DateTime` Postgres
-- mapping) and nullable so existing rows survive `prisma db push`
-- without a backfill, and so the route's `set: 'clear'` path lands
-- cleanly on a previously-stamped row.
--
-- `@@index([teamId, remediatedAt])` keeps the `?remediated=1` chip
-- scan narrow (the team's remediated subset) and a per-team count
-- peer-read off a heap scan once remediated rows are common. Mirrors
-- the (teamId, snoozedUntil) composite posture on the parallel chip.

ALTER TABLE "Alert" ADD COLUMN "remediated_at" TIMESTAMP(3);
CREATE INDEX "Alert_teamId_remediatedAt_idx" ON "Alert"("teamId", "remediated_at");
