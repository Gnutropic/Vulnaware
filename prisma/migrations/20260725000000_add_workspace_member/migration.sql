-- @polsia:user-owned — Canonical per-workspace roster (WorkspaceMember model in
-- prisma/schema/workspace-member.prisma).
--
-- The (workspaceId, email) unique guard is unconditional so the issuer can
-- safely refresh a token in place without spawning a second pending row,
-- mirroring the Invite.model posture.
--
-- The lower-case table names come from auth.prisma's @@map: better-auth's
-- adapter queries `user` (not `User`) so we explicitly reference `user`
-- for the backfill correlate.

CREATE TABLE "WorkspaceMember" (
    "id"              TEXT NOT NULL,
    "workspaceId"     TEXT NOT NULL,
    "email"           TEXT NOT NULL,
    "role"            TEXT NOT NULL,
    "status"          TEXT NOT NULL,
    "invitedByUserId" TEXT NOT NULL,
    "userId"          TEXT,
    "invitedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joinedAt"        TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WorkspaceMember_workspaceId_idx" ON "WorkspaceMember"("workspaceId");
CREATE INDEX "WorkspaceMember_workspaceId_status_idx" ON "WorkspaceMember"("workspaceId", "status");
CREATE INDEX "WorkspaceMember_userId_idx" ON "WorkspaceMember"("userId");

CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_email_key" ON "WorkspaceMember"("workspaceId", "email");

-- ─── Backfill from existing roster state ─────────────────────────────────
-- These statements preserve prior behavior on top of the new schema. They
-- are idempotent via NOT EXISTS so re-running this migration is a no-op.

-- 1. Insert one WorkspaceMember row per existing Membership.
INSERT INTO "WorkspaceMember"
    ("id", "workspaceId", "email", "role", "status", "invitedByUserId", "userId", "invitedAt", "joinedAt", "createdAt")
SELECT
    m."id",
    m."teamId",
    lower(u."email"),
    m."role",
    'active',
    m."userId", -- legacy members self-bootstrap, so inviter == self
    m."userId",
    m."createdAt",
    m."createdAt",
    m."createdAt"
FROM "Membership" m
JOIN "user" u ON u."id" = m."userId"
WHERE NOT EXISTS (
    SELECT 1 FROM "WorkspaceMember" wm
    WHERE wm."workspaceId" = m."teamId" AND wm."email" = lower(u."email")
);

-- 2. Insert one WorkspaceMember row per still-pending Invite (acceptedAt
-- IS NULL). Skips when an active Membership already owns the same
-- (workspaceId, email) — preserves the natural "already a member" story.
INSERT INTO "WorkspaceMember"
    ("id", "workspaceId", "email", "role", "status", "invitedByUserId", "userId", "invitedAt", "joinedAt", "createdAt")
SELECT
    i."id",
    i."teamId",
    lower(i."email"),
    'member',
    'invited',
    i."invitedByUserId",
    NULL,
    i."createdAt",
    NULL,
    i."createdAt"
FROM "Invite" i
WHERE i."acceptedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "WorkspaceMember" wm
    WHERE wm."workspaceId" = i."teamId" AND wm."email" = lower(i."email")
  );
