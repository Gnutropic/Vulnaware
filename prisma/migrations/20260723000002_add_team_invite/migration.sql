-- @polsia:user-owned — Per-team pending invitations (Invite model in
-- prisma/schema/invite.prisma).
--
-- Scalar FKs only — no Team / User back-relations, mirroring Membership.
-- (teamId, email) is conditionally unique: while a row is pending
-- (acceptedAt IS NULL), an admin re-POSTing for the same address refreshes
-- the token in place via UPDATE. Once acceptedAt is set, a follow-up
-- re-POST deletes the prior accepted row and writes a fresh pending row
-- (Prisma's @@unique is unconditional, so deletion-then-insert is the
-- simplest approach). See src/app/api/team/memberships/invite/route.ts.

CREATE TABLE "Invite" (
    "id"              TEXT NOT NULL,
    "teamId"          TEXT NOT NULL,
    "email"           TEXT NOT NULL,
    "tokenHash"       TEXT NOT NULL,
    "expiresAt"       TIMESTAMP(3) NOT NULL,
    "acceptedAt"      TIMESTAMP(3),
    "invitedByUserId" TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Invite_tokenHash_idx" ON "Invite"("tokenHash");
CREATE INDEX "Invite_teamId_idx" ON "Invite"("teamId");

CREATE UNIQUE INDEX "Invite_teamId_email_key" ON "Invite"("teamId", "email");
