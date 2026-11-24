-- @polsia:user-owned — Per-team scheduled cloud-discovery table. Each row
-- captures "this team's <provider> connections should re-enumerate every
-- <cadenceMinutes> minutes, with nextRunAt as the cron drain selector".
-- Reset of cadence on schedule edit happens via update; DELETE handles
-- removal. The PRISMA pipeline MUST run after this migration to keep the
-- TypeScript client in sync (postinstall in package.json does that).

CREATE TABLE "CloudDiscoverySchedule" (
    "id"             TEXT NOT NULL,
    "teamId"         TEXT NOT NULL,
    "provider"       TEXT NOT NULL,
    "cadenceMinutes" INTEGER NOT NULL,
    "lastRunAt"      TIMESTAMP(3),
    "nextRunAt"      TIMESTAMP(3) NOT NULL,
    "createdById"    TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CloudDiscoverySchedule_pkey" PRIMARY KEY ("id")
);

-- Declared after the table so Postgres can verify the target exists.
ALTER TABLE "CloudDiscoverySchedule"
    ADD CONSTRAINT "CloudDiscoverySchedule_teamId_fkey"
    FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE;

CREATE INDEX "CloudDiscoverySchedule_teamId_idx" ON "CloudDiscoverySchedule"("teamId");
CREATE INDEX "CloudDiscoverySchedule_nextRunAt_idx" ON "CloudDiscoverySchedule"("nextRunAt");
