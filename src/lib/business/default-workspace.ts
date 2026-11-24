// @polsia:user-owned — Idempotent signup workspace provisioning.
import 'server-only';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

type WorkspaceProvisioningClient = Pick<
  Prisma.TransactionClient,
  'team' | 'membership' | 'workspace' | 'workspaceMember'
>;
type WorkspaceRowsClient = Pick<Prisma.TransactionClient, 'workspace' | 'workspaceMember'>;

export interface WorkspaceOwner {
  id: string;
  email: string;
}

function defaultTeamName(email: string): string {
  const localPart = email.split('@')[0] ?? 'team';
  const slug =
    localPart
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'team';
  return `ws-${slug}`;
}

function userNameSuffix(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 8);
}

async function findOrCreateDefaultTeam(client: WorkspaceProvisioningClient, user: WorkspaceOwner) {
  const baseName = defaultTeamName(user.email);
  const suffix = userNameSuffix(user.id);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidateName =
      attempt === 0
        ? baseName
        : `${baseName.slice(0, 39)}-${suffix}${attempt === 1 ? '' : `-${attempt}`}`;
    const existing = await client.team.findUnique({ where: { name: candidateName } });
    if (!existing) {
      return client.team.create({ data: { name: candidateName } });
    }

    const [workspace, member] = await Promise.all([
      client.workspace.findUnique({
        where: { id: existing.id },
        select: { ownerUserId: true },
      }),
      client.membership.findFirst({
        where: { teamId: existing.id },
        select: { userId: true },
      }),
    ]);
    const ownedByAnotherUser =
      (workspace?.ownerUserId != null && workspace.ownerUserId !== user.id) ||
      (member != null && member.userId !== user.id);
    if (!ownedByAnotherUser) return existing;
  }

  throw new Error('Could not resolve a unique default team name for this user');
}

/** Ensures a workspace root and active owner roster row for an existing Team. */
export async function ensureWorkspaceForTeam(
  client: WorkspaceRowsClient,
  user: WorkspaceOwner,
  team: { id: string; name: string },
  options: { forceOwner?: boolean } = {},
): Promise<void> {
  const email = user.email.trim().toLowerCase();
  const existingWorkspace = await client.workspace.findUnique({
    where: { id: team.id },
    select: { ownerUserId: true },
  });
  const maySetOwner =
    options.forceOwner === true ||
    existingWorkspace === null ||
    existingWorkspace.ownerUserId === null ||
    existingWorkspace.ownerUserId === user.id;

  await client.workspace.upsert({
    where: { id: team.id },
    create: { id: team.id, name: team.name, ownerUserId: user.id },
    update: maySetOwner ? { ownerUserId: user.id } : {},
  });

  const workspaceMember = await client.workspaceMember.findUnique({
    where: { workspaceId_email: { workspaceId: team.id, email } },
    select: { joinedAt: true },
  });
  const now = new Date();
  await client.workspaceMember.upsert({
    where: { workspaceId_email: { workspaceId: team.id, email } },
    create: {
      workspaceId: team.id,
      email,
      role: 'admin',
      status: 'active',
      invitedByUserId: user.id,
      userId: user.id,
      invitedAt: now,
      joinedAt: now,
    },
    update: {
      role: 'admin',
      status: 'active',
      userId: user.id,
      joinedAt: workspaceMember?.joinedAt ?? now,
    },
  });
}

/** Removes a provisional owner row and its root when a flow selects another Team. */
export async function removeProvisionalWorkspace(
  client: WorkspaceRowsClient,
  ownerUserId: string,
  workspaceId: string,
): Promise<void> {
  await client.workspaceMember.deleteMany({
    where: { workspaceId, userId: ownerUserId },
  });
  const remainingRosterCount = await client.workspaceMember.count({
    where: { workspaceId },
  });
  if (remainingRosterCount === 0) {
    await client.workspace.deleteMany({
      where: { id: workspaceId, ownerUserId },
    });
  } else {
    await client.workspace.updateMany({
      where: { id: workspaceId, ownerUserId },
      data: { ownerUserId: null },
    });
  }
}

/** Resolves the user's canonical Team/Membership and repairs its workspace rows. */
export async function provisionDefaultWorkspace(
  client: WorkspaceProvisioningClient,
  user: WorkspaceOwner,
): Promise<{ teamId: string }> {
  const membership = await client.membership.findUnique({
    where: { userId: user.id },
    select: { teamId: true },
  });

  let team = membership
    ? await client.team.findUniqueOrThrow({ where: { id: membership.teamId } })
    : await findOrCreateDefaultTeam(client, user);

  if (!membership) {
    await client.membership.upsert({
      where: { userId: user.id },
      create: { userId: user.id, teamId: team.id, role: 'admin' },
      update: {},
    });
    const canonicalMembership = await client.membership.findUniqueOrThrow({
      where: { userId: user.id },
      select: { teamId: true },
    });
    if (canonicalMembership.teamId !== team.id) {
      team = await client.team.findUniqueOrThrow({
        where: { id: canonicalMembership.teamId },
      });
    }
  }

  await ensureWorkspaceForTeam(client, user, team);
  return { teamId: team.id };
}

function isRetryableProvisioningConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === 'P2002' || error.code === 'P2034';
}

/** Runs signup provisioning atomically and retries concurrent unique-key races. */
export async function ensureDefaultWorkspace(user: WorkspaceOwner): Promise<{ teamId: string }> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await prisma.$transaction((tx) => provisionDefaultWorkspace(tx, user));
    } catch (error) {
      if (!isRetryableProvisioningConflict(error) || attempt === 7) throw error;
      const backoffMs = 10 * 2 ** attempt + Math.floor(Math.random() * 20);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw new Error('Could not provision a default workspace');
}
