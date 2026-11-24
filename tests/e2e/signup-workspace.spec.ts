// @polsia:user-owned — Signup browser journey and persisted workspace check.
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const email = `browser-signup-${randomUUID()}@example.invalid`;
let userId: string | undefined;
let workspaceId: string | undefined;

test.afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  userId ??= user?.id;
  if (userId) {
    const membership = await prisma.membership.findUnique({
      where: { userId },
      select: { teamId: true },
    });
    workspaceId ??= membership?.teamId;
  }
  if (userId) {
    await prisma.session.deleteMany({ where: { userId } });
    await prisma.account.deleteMany({ where: { userId } });
    await prisma.membership.deleteMany({ where: { userId } });
    await prisma.workspaceMember.deleteMany({ where: { userId } });
    if (workspaceId) {
      await prisma.trialWorkspace.deleteMany({ where: { teamId: workspaceId } });
      await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
      await prisma.workspace.deleteMany({ where: { id: workspaceId } });
      await prisma.team.deleteMany({ where: { id: workspaceId } });
    }
    await prisma.userSubscription.deleteMany({ where: { userId } });
    await prisma.dailyDigestPrefs.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
  await prisma.$disconnect();
});

test('signup reaches the dashboard with an owned workspace and active owner roster row', async ({
  page,
}) => {
  await page.goto('/signup');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic Signup Passphrase!23');
  await page.getByLabel('Confirm password').fill('Synthetic Signup Passphrase!23');
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page).toHaveURL(/\/dashboard(?:\/|$)/, { timeout: 30_000 });

  const session = await page.evaluate(async () => {
    const response = await fetch('/api/auth/get-session', { credentials: 'include' });
    return response.ok ? response.json() : null;
  });
  expect(session).toMatchObject({ user: { email } });

  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true, email: true },
  });
  userId = user.id;
  const membership = await prisma.membership.findUniqueOrThrow({
    where: { userId: user.id },
    select: { teamId: true, role: true },
  });
  workspaceId = membership.teamId;
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: membership.teamId },
  });
  const owner = await prisma.workspaceMember.findUniqueOrThrow({
    where: {
      workspaceId_email: { workspaceId: membership.teamId, email: user.email.toLowerCase() },
    },
  });

  expect(membership.role).toBe('admin');
  expect(workspace.ownerUserId).toBe(user.id);
  expect(await prisma.workspace.count({ where: { ownerUserId: user.id } })).toBe(1);
  expect(owner).toMatchObject({
    workspaceId: membership.teamId,
    userId: user.id,
    role: 'admin',
    status: 'active',
  });
});
