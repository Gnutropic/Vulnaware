-- @polsia:user-owned — Add `remediatedByEmail` on `Alert`. Mirrors the
-- additive-only posture of every prior Alert stamp migration
-- (closedAt / closedBy / reopeningAt / reopenedAt / remediatedAt):
-- ALTER TABLE … ADD COLUMN is forward-only and never touches existing
-- rows. The column is TEXT (Prisma's `String?` Postgres mapping for
-- a nullable string) and nullable so existing rows survive
-- `prisma db push` without a backfill, and so the route's optional
-- write path can stamp the caller-email on the same write that
-- stamps `remediatedAt` without a column default.
--
-- No `CREATE INDEX` here — the column is read-only ("render: who
-- stamped this?"), and the list path's active filter chip reads on
-- `remediatedAt`, not on `remediatedByEmail`. A future chip that
-- filters "remediated by me" would land a `name: "Alert_teamId_remediatedByEmail_idx"`
-- on the same composite posture.

ALTER TABLE "Alert" ADD COLUMN "remediatedByEmail" TEXT;
