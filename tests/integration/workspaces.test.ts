// @polsia:user-owned — Disposable-PostgreSQL workspace model integration check.
// Run after `npx prisma db push` with DATABASE_URL pointed at the sandbox DB.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { seed } from '../../src/lib/seed';

const prisma = new PrismaClient();
const suffix = randomUUID();
const testTeamIds: [string, string, string] = [
  `workspace-test-admin-${suffix}`,
  `workspace-test-trial-${suffix}`,
  `workspace-test-ownerless-${suffix}`,
];
const testWorkspaceIds: [string, string] = [
  `workspace-test-one-${suffix}`,
  `workspace-test-two-${suffix}`,
];

async function verifyWorkspaceBackfill(): Promise<void> {
  const alertCountBefore = await prisma.alert.count();
  const initialWorkspaceCount = await prisma.workspace.count();
  const rosterBefore = await prisma.workspaceMember.findMany({
    orderBy: { id: 'asc' },
    select: {
      id: true,
      workspaceId: true,
      userId: true,
      role: true,
      status: true,
      invitedAt: true,
      joinedAt: true,
      createdAt: true,
    },
  });
  const existingTeams = await prisma.team.findMany({ select: { id: true } });
  const existingWorkspaceIds = new Set(
    (
      await prisma.workspace.findMany({
        where: { id: { in: existingTeams.map((team) => team.id) } },
        select: { id: true },
      })
    ).map((workspace) => workspace.id),
  );
  const missingExistingWorkspaceCount = existingTeams.filter(
    (team) => !existingWorkspaceIds.has(team.id),
  ).length;

  const trialTeamId = testTeamIds[0];
  const adminTeamId = testTeamIds[1];
  const ownerlessTeamId = testTeamIds[2];
  const createdAt = new Date('2026-01-01T00:00:00.000Z');

  await prisma.team.createMany({
    data: testTeamIds.map((id, index) => ({
      id,
      name: `Workspace test ${suffix} ${index}`,
      createdAt,
    })),
  });

  await prisma.membership.createMany({
    data: [
      {
        id: `workspace-test-admin-old-${suffix}`,
        userId: `workspace-test-admin-old-user-${suffix}`,
        teamId: trialTeamId,
        role: 'admin',
        createdAt,
      },
      {
        id: `workspace-test-admin-new-${suffix}`,
        userId: `workspace-test-admin-new-user-${suffix}`,
        teamId: trialTeamId,
        role: 'admin',
        createdAt: new Date(createdAt.getTime() + 1_000),
      },
      {
        id: `workspace-test-fallback-old-${suffix}`,
        userId: `workspace-test-fallback-old-user-${suffix}`,
        teamId: adminTeamId,
        role: 'admin',
        createdAt,
      },
      {
        id: `workspace-test-fallback-new-${suffix}`,
        userId: `workspace-test-fallback-new-user-${suffix}`,
        teamId: adminTeamId,
        role: 'admin',
        createdAt: new Date(createdAt.getTime() + 1_000),
      },
    ],
  });

  await prisma.trialWorkspace.create({
    data: {
      teamId: trialTeamId,
      ownerUserId: `workspace-test-trial-owner-${suffix}`,
      trialEndsAt: new Date('2026-02-01T00:00:00.000Z'),
    },
  });

  await seed();

  const backfilledWorkspaceIds = new Set(
    (
      await prisma.workspace.findMany({
        where: { id: { in: existingTeams.map((team) => team.id) } },
        select: { id: true },
      })
    ).map((workspace) => workspace.id),
  );
  assert.equal(
    existingTeams.every((team) => backfilledWorkspaceIds.has(team.id)),
    true,
    'every legacy Team must have a Workspace with the same ID',
  );

  const [trialWorkspace, adminWorkspace, ownerlessWorkspace] = await Promise.all([
    prisma.workspace.findUniqueOrThrow({ where: { id: trialTeamId } }),
    prisma.workspace.findUniqueOrThrow({ where: { id: adminTeamId } }),
    prisma.workspace.findUniqueOrThrow({ where: { id: ownerlessTeamId } }),
  ]);

  assert.equal(trialWorkspace.ownerUserId, `workspace-test-trial-owner-${suffix}`);
  assert.equal(adminWorkspace.ownerUserId, `workspace-test-fallback-old-user-${suffix}`);
  assert.equal(ownerlessWorkspace.ownerUserId, null);
  assert.equal(trialWorkspace.createdAt.toISOString(), createdAt.toISOString());

  await seed();
  assert.equal(
    await prisma.workspace.count(),
    initialWorkspaceCount + missingExistingWorkspaceCount + testTeamIds.length,
    'seed reruns must not duplicate workspace roots',
  );
  assert.equal(await prisma.alert.count(), alertCountBefore);
  assert.deepEqual(
    await prisma.workspaceMember.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        workspaceId: true,
        userId: true,
        role: true,
        status: true,
        invitedAt: true,
        joinedAt: true,
        createdAt: true,
      },
    }),
    rosterBefore,
    'backfill must preserve existing active and invited roster rows',
  );
}

async function verifyMembershipConstraints(): Promise<void> {
  const userId = `workspace-test-multi-user-${suffix}`;

  await prisma.workspace.createMany({
    data: testWorkspaceIds.map((id) => ({ id, name: id })),
  });

  const first = await prisma.workspaceMember.create({
    data: {
      workspaceId: testWorkspaceIds[0],
      email: `first-${suffix}@example.invalid`,
      status: 'active',
      invitedByUserId: `workspace-test-inviter-${suffix}`,
      userId,
    },
  });
  const second = await prisma.workspaceMember.create({
    data: {
      workspaceId: testWorkspaceIds[1],
      email: `second-${suffix}@example.invalid`,
      status: 'active',
      invitedByUserId: `workspace-test-inviter-${suffix}`,
      userId,
    },
  });

  assert.equal(first.role, 'member');
  assert.equal(second.role, 'member');

  await prisma.workspaceMember.createMany({
    data: [
      {
        workspaceId: testWorkspaceIds[0],
        email: `invite-one-${suffix}@example.invalid`,
        status: 'invited',
        invitedByUserId: `workspace-test-inviter-${suffix}`,
      },
      {
        workspaceId: testWorkspaceIds[0],
        email: `invite-two-${suffix}@example.invalid`,
        status: 'invited',
        invitedByUserId: `workspace-test-inviter-${suffix}`,
      },
    ],
  });
}

async function main(): Promise<void> {
  try {
    await verifyWorkspaceBackfill();
    await verifyMembershipConstraints();
  } finally {
    await prisma.workspaceMember.deleteMany({
      where: { workspaceId: { in: [...testTeamIds, ...testWorkspaceIds] } },
    });
    await prisma.workspace.deleteMany({
      where: { id: { in: [...testTeamIds, ...testWorkspaceIds] } },
    });
    await prisma.trialWorkspace.deleteMany({ where: { teamId: { in: testTeamIds } } });
    await prisma.membership.deleteMany({ where: { teamId: { in: testTeamIds } } });
    await prisma.team.deleteMany({ where: { id: { in: testTeamIds } } });
    await prisma.$disconnect();
  }
}

void main();
