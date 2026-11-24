-- @polsia:user-owned — Add `ownerId` column to `Alert` so a team member can
-- claim each CVE from the detail page. Mirrors the existing `assigneeId`
-- posture: scalar FK into `WorkspaceMember.id` (no Prisma relation edge, no
-- SQL foreign-key constraint), validated at the route layer by the new
-- /api/alerts/[id]/owner handler.
--
-- The column is nullable without a default — `prisma db push` is non-
-- destructive on existing rows so no backfill is required.
--
-- The (teamId, ownerId) composite index keeps future "owned by me" / per-
-- workspace roster views from going to a heap scan while costing nothing on
-- the write path (the only write today is a single-row update).

ALTER TABLE "Alert" ADD COLUMN "ownerId" TEXT;

CREATE INDEX "Alert_teamId_ownerId_idx" ON "Alert"("teamId", "ownerId");
