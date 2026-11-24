-- @polsia:user-owned — Per-team nightly competitive-intelligence audit results.
-- One row per (team, ranAt) where ranAt is the start of the UTC day the
-- cron fired; the unique constraint enforces idempotency across retries
-- and a double-tick of the same minute.
--
-- Naming note: the original brief named the FK column "workspaceId"; every
-- per-team FK in this repo already uses `teamId` (the latent `Team` model
-- lives in api-key.prisma; there is no Workspace primitive), so the column
-- is renamed to `teamId` to fit the existing `requireTeamRead()` /
-- `getMyTeam()` helpers without a parallel mapping layer.
--
-- The PRISMA pipeline MUST run after this migration (postinstall in
-- package.json does that) so the TypeScript client picks up the new model.

CREATE TABLE "CompetitiveIntelRun" (
    "id"        TEXT NOT NULL,
    "teamId"    TEXT NOT NULL,
    "ranAt"     TIMESTAMP(3) NOT NULL,
    "headline"  TEXT NOT NULL,
    "body"      TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CompetitiveIntelRun_pkey" PRIMARY KEY ("id")
);

-- Declared after the table so Postgres can verify the target exists.
ALTER TABLE "CompetitiveIntelRun"
    ADD CONSTRAINT "CompetitiveIntelRun_teamId_fkey"
    FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE;

CREATE UNIQUE INDEX "CompetitiveIntelRun_teamId_ranAt_key"
    ON "CompetitiveIntelRun"("teamId", "ranAt");

CREATE INDEX "CompetitiveIntelRun_teamId_ranAt_idx"
    ON "CompetitiveIntelRun"("teamId", "ranAt");

CREATE INDEX "CompetitiveIntelRun_teamId_idx"
    ON "CompetitiveIntelRun"("teamId");
