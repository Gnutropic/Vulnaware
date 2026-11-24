// @polsia:user-owned — Disposable-PostgreSQL signup and trial workspace check.
// Run against the local app server and disposable database described in tests/README.md.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  ensureDefaultWorkspace,
  provisionDefaultWorkspace,
} from '../../src/lib/business/default-workspace';

const prisma = new PrismaClient();
const suffix = randomUUID().replaceAll('-', '').slice(0, 14);
const baseUrl = new URL(process.env.BASE_URL ?? process.env.BETTER_AUTH_URL ?? 'http://127.0.0.1:3000');
const testUsers: Array<{ id: string; email: string }> = [];
const testEmails = new Set<string>();
const relatedTeamIds = new Set<string>();

async function post(path: string, body: Record<string, string>) {
  return fetch(new URL(path, baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: baseUrl.origin,
    },
    body: JSON.stringify(body),
  });
}

async function register(email: string, password: string): Promise<string> {
  testEmails.add(email.toLowerCase());
  const response = await post('/api/auth/sign-up/email', {
    email,
    password,
    name: email.split('@')[0] ?? 'workspace-test',
  });
  const payload = (await response.json()) as { user?: { id?: unknown }; id?: unknown };
  assert.equal(response.ok, true, `signup endpoint returned ${response.status}`);
  const userId = payload.user?.id ?? payload.id;
  assert.equal(typeof userId, 'string', 'signup response contains a user id');
  const id = userId as string;
  testUsers.push({ id, email });
  return id;
}

async function assertOwnedWorkspace(userId: string, email: string): Promise<string> {
  const membership = await prisma.membership.findUniqueOrThrow({
    where: { userId },
    select: { teamId: true, role: true },
  });
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: membership.teamId },
  });
  const ownerRoster = await prisma.workspaceMember.findUniqueOrThrow({
    where: {
      workspaceId_email: { workspaceId: membership.teamId, email: email.toLowerCase() },
    },
  });

  assert.equal(membership.role, 'admin');
  assert.equal(workspace.id, membership.teamId);
  assert.equal(workspace.ownerUserId, userId);
  assert.equal(ownerRoster.userId, userId);
  assert.equal(ownerRoster.role, 'admin');
  assert.equal(ownerRoster.status, 'active');
  assert.equal(await prisma.workspace.count({ where: { ownerUserId: userId } }), 1);
  return membership.teamId;
}

async function assertTrialWorkspace(email: string): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true, email: true },
  });
  if (!testUsers.some((candidate) => candidate.id === user.id)) testUsers.push(user);
  const teamId = await assertOwnedWorkspace(user.id, user.email);
  assert.equal(await prisma.trialWorkspace.count({ where: { teamId } }), 1);
  relatedTeamIds.add(teamId);
  const defaultName = `ws-${email.split('@')[0]}`;
  const provisionalTeam = await prisma.team.findUnique({ where: { name: defaultName } });
  if (provisionalTeam) relatedTeamIds.add(provisionalTeam.id);
  return teamId;
}

async function cleanup(): Promise<void> {
  for (const email of testEmails) {
    const provisionalTeam = await prisma.team.findUnique({
      where: { name: `ws-${email.split('@')[0]}` },
      select: { id: true },
    });
    if (provisionalTeam) relatedTeamIds.add(provisionalTeam.id);
  }
  if (testEmails.size > 0) {
    const discoveredUsers = await prisma.user.findMany({
      where: { email: { in: [...testEmails] } },
      select: { id: true, email: true },
    });
    for (const user of discoveredUsers) {
      if (!testUsers.some((candidate) => candidate.id === user.id)) testUsers.push(user);
    }
  }
  const userIds = testUsers.map((user) => user.id);
  const emailAddresses = testUsers.map((user) => user.email.toLowerCase());
  const memberships = userIds.length
    ? await prisma.membership.findMany({ where: { userId: { in: userIds } }, select: { teamId: true } })
    : [];
  for (const membership of memberships) relatedTeamIds.add(membership.teamId);
  const teamIds = [...relatedTeamIds];

  if (userIds.length > 0) {
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.account.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.membership.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.workspaceMember.deleteMany({
      where: { OR: [{ userId: { in: userIds } }, { email: { in: emailAddresses } }] },
    });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: teamIds } } });
    await prisma.workspace.deleteMany({
      where: { OR: [{ id: { in: teamIds } }, { ownerUserId: { in: userIds } }] },
    });
    await prisma.trialWorkspace.deleteMany({ where: { teamId: { in: teamIds } } });
    await prisma.trialFunnelEvent.deleteMany({
      where: { OR: [{ userId: { in: userIds } }, { teamId: { in: teamIds } }] },
    });
    await prisma.userSubscription.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.dailyDigestPrefs.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  if (teamIds.length > 0) await prisma.team.deleteMany({ where: { id: { in: teamIds } } });
}

async function main(): Promise<void> {
  await prisma.$connect();
  try {
    const email = `default-${suffix}@example.invalid`;
    const password = `Synthetic-${suffix}-Passphrase!`;
    const userId = await register(email, password);
    const teamId = await assertOwnedWorkspace(userId, email);
    relatedTeamIds.add(teamId);

    const [membershipCountBefore, ownedWorkspaceCountBefore, ownerRosterCountBefore] =
      await Promise.all([
        prisma.membership.count({ where: { userId } }),
        prisma.workspace.count({ where: { ownerUserId: userId } }),
        prisma.workspaceMember.count({ where: { userId } }),
      ]);

    const duplicateSignup = await post('/api/auth/sign-up/email', {
      email,
      password: `Different-${suffix}-Passphrase!`,
      name: 'duplicate-workspace-test',
    });
    await duplicateSignup.arrayBuffer();
    const signIn = await post('/api/auth/sign-in/email', { email, password });
    assert.equal(signIn.ok, true, `existing-user sign-in returned ${signIn.status}`);
    await signIn.arrayBuffer();

    await Promise.all(Array.from({ length: 8 }, () => ensureDefaultWorkspace({ id: userId, email })));
    assert.equal(await prisma.membership.count({ where: { userId } }), membershipCountBefore);
    assert.equal(await prisma.workspace.count({ where: { ownerUserId: userId } }), ownedWorkspaceCountBefore);
    assert.equal(await prisma.workspaceMember.count({ where: { userId } }), ownerRosterCountBefore);

    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await tx.workspaceMember.deleteMany({ where: { workspaceId: teamId, userId } });
        await tx.workspace.deleteMany({ where: { id: teamId } });
        await provisionDefaultWorkspace(tx, { id: userId, email });
        throw new Error('synthetic transaction rollback');
      }),
      /synthetic transaction rollback/,
    );
    assert.equal(await prisma.workspace.findUnique({ where: { id: teamId } }) !== null, true);
    assert.equal(
      await prisma.workspaceMember.count({ where: { workspaceId: teamId, userId } }),
      1,
    );

    await prisma.$transaction(async (tx) => {
      await tx.workspaceMember.deleteMany({ where: { workspaceId: teamId, userId } });
      await tx.workspace.deleteMany({ where: { id: teamId } });
    });
    await ensureDefaultWorkspace({ id: userId, email });
    assert.equal(await assertOwnedWorkspace(userId, email), teamId);

    const legacyTrialEmail = `legacy-trial-${suffix}@example.invalid`;
    testEmails.add(legacyTrialEmail);
    const legacyTrial = await post('/api/trial/signup', {
      email: legacyTrialEmail,
      company: 'Workspace Test Company',
      workspaceName: `Legacy Trial ${suffix}`,
    });
    assert.equal(legacyTrial.ok, true, `legacy trial endpoint returned ${legacyTrial.status}`);
    await legacyTrial.arrayBuffer();
    const legacyTeamId = await assertTrialWorkspace(legacyTrialEmail);
    const legacyRetry = await post('/api/trial/signup', {
      email: legacyTrialEmail,
      company: 'Workspace Test Company',
      workspaceName: `Legacy Trial Retry ${suffix}`,
    });
    assert.equal(legacyRetry.ok, true);
    await legacyRetry.arrayBuffer();
    assert.equal(await assertTrialWorkspace(legacyTrialEmail), legacyTeamId);

    const tieredTrialEmail = `tiered-trial-${suffix}@example.invalid`;
    testEmails.add(tieredTrialEmail);
    const tieredPassword = `Synthetic-${suffix}-TrialPass!`;
    const tieredTrial = await post('/api/trial/tiered-signup', {
      email: tieredTrialEmail,
      password: tieredPassword,
      workspaceName: `Tiered Trial ${suffix}`,
      tier: 'starter',
    });
    assert.equal(tieredTrial.ok, true, `tiered trial endpoint returned ${tieredTrial.status}`);
    await tieredTrial.arrayBuffer();
    const tieredTeamId = await assertTrialWorkspace(tieredTrialEmail);
    const tieredRetry = await post('/api/trial/tiered-signup', {
      email: tieredTrialEmail,
      password: tieredPassword,
      workspaceName: `Tiered Trial Retry ${suffix}`,
      tier: 'pro',
    });
    assert.equal(tieredRetry.ok, true);
    await tieredRetry.arrayBuffer();
    assert.equal(await assertTrialWorkspace(tieredTrialEmail), tieredTeamId);
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

void main();
