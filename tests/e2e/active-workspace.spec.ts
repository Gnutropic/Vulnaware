// @polsia:user-owned — Real authenticated active-workspace API journey.
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { expect, test } from '@playwright/test';

const prisma = new PrismaClient();
const email = `active-workspace-${randomUUID()}@example.invalid`;
const fixtureWorkspaceIds: string[] = [];
let userId: string | undefined;
let ownedWorkspaceId: string | undefined;

test.afterAll(async () => {
  try {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    userId ??= user?.id;

    const workspaceIds = new Set(fixtureWorkspaceIds);
    if (userId) {
      const membership = await prisma.membership.findUnique({
        where: { userId },
        select: { teamId: true },
      });
      ownedWorkspaceId ??= membership?.teamId;
      if (ownedWorkspaceId) workspaceIds.add(ownedWorkspaceId);

      await prisma.session.deleteMany({ where: { userId } });
      await prisma.account.deleteMany({ where: { userId } });
      await prisma.membership.deleteMany({ where: { userId } });
      await prisma.userSubscription.deleteMany({ where: { userId } });
      await prisma.dailyDigestPrefs.deleteMany({ where: { userId } });
    }

    if (workspaceIds.size > 0) {
      const ids = [...workspaceIds];
      await prisma.trialWorkspace.deleteMany({ where: { teamId: { in: ids } } });
      await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: ids } } });
      await prisma.workspace.deleteMany({ where: { id: { in: ids } } });
      await prisma.team.deleteMany({ where: { id: { in: ids } } });
    }
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  } finally {
    await prisma.$disconnect();
  }
});

test('selects an active member workspace and rejects inaccessible selections', async ({ page }) => {
  await page.goto('/signup');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic Workspace Passphrase!23');
  await page.getByLabel('Confirm password').fill('Synthetic Workspace Passphrase!23');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\/|$)/, { timeout: 30_000 });

  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true, email: true },
  });
  userId = user.id;

  const ownedWorkspace = await prisma.workspace.findFirstOrThrow({
    where: { ownerUserId: user.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  ownedWorkspaceId = ownedWorkspace.id;

  const memberWorkspace = await prisma.workspace.create({
    data: { name: `Active workspace fixture ${randomUUID()}` },
    select: { id: true },
  });
  fixtureWorkspaceIds.push(memberWorkspace.id);
  await prisma.workspaceMember.create({
    data: {
      workspaceId: memberWorkspace.id,
      email: user.email,
      role: 'member',
      status: 'active',
      invitedByUserId: user.id,
      userId: user.id,
      joinedAt: new Date(),
    },
  });

  const inaccessibleWorkspace = await prisma.workspace.create({
    data: { name: `Inaccessible workspace fixture ${randomUUID()}` },
    select: { id: true },
  });
  fixtureWorkspaceIds.push(inaccessibleWorkspace.id);

  const workspaceRowsBefore = await prisma.workspace.findMany({
    where: { id: { in: [...fixtureWorkspaceIds, ownedWorkspace.id] } },
    orderBy: { id: 'asc' },
    select: { id: true, ownerUserId: true },
  });
  const membershipRowsBefore = await prisma.workspaceMember.findMany({
    where: { OR: [{ userId: user.id }, { workspaceId: { in: fixtureWorkspaceIds } }] },
    orderBy: { id: 'asc' },
    select: { id: true, workspaceId: true, userId: true, status: true },
  });

  const selectMemberWorkspace = await page.evaluate(async (workspaceId) => {
    const response = await fetch('/api/workspace/active', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId }),
    });
    return { status: response.status, body: await response.json() };
  }, memberWorkspace.id);
  expect(selectMemberWorkspace).toEqual({
    status: 200,
    body: { workspaceId: memberWorkspace.id },
  });

  const selectedWorkspace = await page.evaluate(async () => {
    const response = await fetch('/api/workspace/active');
    return { status: response.status, body: await response.json() };
  });
  expect(selectedWorkspace).toEqual({
    status: 200,
    body: { workspaceId: memberWorkspace.id },
  });

  const rejectInaccessibleWorkspace = await page.evaluate(async (workspaceId) => {
    const response = await fetch('/api/workspace/active', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId }),
    });
    return { status: response.status };
  }, inaccessibleWorkspace.id);
  expect(rejectInaccessibleWorkspace.status).toBe(403);

  const retainedWorkspace = await page.evaluate(async () => {
    const response = await fetch('/api/workspace/active');
    return { status: response.status, body: await response.json() };
  });
  expect(retainedWorkspace).toEqual({
    status: 200,
    body: { workspaceId: memberWorkspace.id },
  });

  await page.context().addCookies([
    {
      name: 'polsia_active_workspace',
      value: 'deleted-workspace-fixture',
      url: new URL(page.url()).origin,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
  const staleCookieFallback = await page.evaluate(async () => {
    const response = await fetch('/api/workspace/active');
    return { status: response.status, body: await response.json() };
  });
  expect(staleCookieFallback).toEqual({
    status: 200,
    body: { workspaceId: ownedWorkspace.id },
  });

  expect(
    await prisma.workspace.findMany({
      where: { id: { in: [...fixtureWorkspaceIds, ownedWorkspace.id] } },
      orderBy: { id: 'asc' },
      select: { id: true, ownerUserId: true },
    }),
  ).toEqual(workspaceRowsBefore);
  expect(
    await prisma.workspaceMember.findMany({
      where: { OR: [{ userId: user.id }, { workspaceId: { in: fixtureWorkspaceIds } }] },
      orderBy: { id: 'asc' },
      select: { id: true, workspaceId: true, userId: true, status: true },
    }),
  ).toEqual(membershipRowsBefore);
});
