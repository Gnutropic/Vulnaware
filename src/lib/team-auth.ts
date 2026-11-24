// @polsia:user-owned — Team membership helpers used by per-team API routes
// and Server Components. Mirrors require-auth.ts / require-admin.ts posture:
// caller wraps the requiring call and rethrows the thrown Response on rejection.
//
//   try {
//     const ctx = await requireTeamRole('admin');
//     // ctx: { user, membership, team }
//   } catch (res) { return res as Response; }
//
// Server-only — never import from a 'use client' file. Stricter than the
// auth-gate helpers in require-auth.ts: not only do we reject anonymous
// callers, we reject users who lack a team row (the bootstrap has not run)
// and reject role-underspec'd callers.

import 'server-only';
import { prisma } from '@/lib/db';
import type { Role } from '@/lib/permissions/roles';
import { hasAtLeast } from '@/lib/permissions/roles';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export interface MembershipContext {
  user: SessionUser;
  membership: { id: string; userId: string; teamId: string; role: string };
  team: { id: string; name: string };
}

export interface MembershipRow {
  id: string;
  userId: string;
  teamId: string;
  role: string;
}

/** Look up the caller's team membership. Returns null when the user is
 *  signed-in but has no membership row (bootstrap has not run). */
export async function getMembershipForUser(userId: string): Promise<MembershipRow | null> {
  const row = await prisma.membership.findUnique({
    where: { userId },
    select: { id: true, userId: true, teamId: true, role: true },
  });
  return row;
}

export async function getMyTeam(userId: string): Promise<{ id: string; name: string } | null> {
  const membership = await getMembershipForUser(userId);
  if (!membership) return null;
  const team = await prisma.team.findUnique({
    where: { id: membership.teamId },
    select: { id: true, name: true },
  });
  return team;
}

/** Throws a 401 anon Response or a 404 if the signed-in user has no team. */
export async function requireTeamRead(): Promise<MembershipContext> {
  const user = await requireAuth();
  const membership = await getMembershipForUser(user.id);
  if (!membership) {
    throw Response.json({ error: 'No team' }, { status: 404 });
  }
  const team = await prisma.team.findUnique({
    where: { id: membership.teamId },
    select: { id: true, name: true },
  });
  if (!team) {
    throw Response.json({ error: 'No team' }, { status: 404 });
  }
  return { user, membership, team };
}

/** Throws 401 anon, 403 if the role is below the minimum, 404 if no team. */
export async function requireTeamRole(min: Role): Promise<MembershipContext> {
  const ctx = await requireTeamRead();
  if (!hasAtLeast(ctx.membership.role, min)) {
    throw Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  return ctx;
}
