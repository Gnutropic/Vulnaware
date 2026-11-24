// @polsia:user-owned — Authenticated asset hostname-search journey.
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { expect, test } from '@playwright/test';

const prisma = new PrismaClient();
const email = `assets-search-${randomUUID()}@example.invalid`;
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
      await prisma.workspaceMember.deleteMany({ where: { userId } });
    }

    if (workspaceIds.size > 0) {
      const ids = [...workspaceIds];
      await prisma.alert.deleteMany({ where: { teamId: { in: ids } } });
      await prisma.scan.deleteMany({ where: { teamId: { in: ids } } });
      await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: ids } } });
      await prisma.workspace.deleteMany({ where: { id: { in: ids } } });
      await prisma.team.deleteMany({ where: { id: { in: ids } } });
    }
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  } finally {
    await prisma.$disconnect();
  }
});

test('hostname search retains list URL state and follows the active workspace', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto('/signup');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic Assets Passphrase!23');
  await page.getByLabel('Confirm password').fill('Synthetic Assets Passphrase!23');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\/|$)/, { timeout: 30_000 });

  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true, email: true },
  });
  userId = user.id;

  const first = await createWorkspace(user.id, user.email, 'first');
  const second = await createWorkspace(user.id, user.email, 'second');
  const sharedHost = `shared-${randomUUID()}.example.invalid`;
  const firstOnlyHost = `first-only-${randomUUID()}.example.invalid`;
  const secondOnlyHost = `second-only-${randomUUID()}.example.invalid`;
  await createAlert(first, sharedHost);
  await createAlert(first, firstOnlyHost);
  await createAlert(second, sharedHost);
  await createAlert(second, secondOnlyHost);

  await selectWorkspace(page, first.id);
  await page.goto('/assets?severity=high&status=open&sort=name&page=1&pageSize=50');
  await expect(page.getByRole('heading', { name: 'Assets' })).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'Search assets by hostname' });
  await search.fill(firstOnlyHost);
  await expect(page).toHaveURL(
    new RegExp(
      `severity=high&status=open&sort=name&page=1&pageSize=50&q=${encodeURIComponent(firstOnlyHost)}`,
    ),
    { timeout: 10_000 },
  );
  await expect(page.getByRole('link', { name: firstOnlyHost })).toBeVisible();
  await expect(page.getByRole('link', { name: secondOnlyHost })).toHaveCount(0);

  const firstResponse = await page.evaluate(async () => {
    const response = await fetch(`/api/assets${window.location.search}`);
    return response.json();
  });
  expect(firstResponse.items.map((item: { name: string }) => item.name)).toEqual([firstOnlyHost]);

  await selectWorkspace(page, second.id);
  await page.goto(`/assets?q=${encodeURIComponent(firstOnlyHost)}`);
  await expect(page.getByRole('cell').getByText(`No assets matching “${firstOnlyHost}”`)).toBeVisible();
  await expect(
    page.getByRole('cell').getByRole('link', { name: 'Clear hostname search' }),
  ).toBeVisible();

  await page.getByRole('cell').getByRole('link', { name: 'Clear hostname search' }).click();
  await expect(page).toHaveURL(/\/assets(?:\?|$)/);
  await expect(page.getByRole('link', { name: sharedHost })).toBeVisible();
  await expect(page.getByRole('link', { name: secondOnlyHost })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('searchbox', { name: 'Search assets by hostname' }).fill('not-found.example.invalid');
  await expect(
    page.locator('ul').getByText('No assets matching “not-found.example.invalid”'),
  ).toBeVisible();
  await expect(
    page.locator('ul').getByRole('link', { name: 'Clear hostname search' }),
  ).toBeVisible();
});

interface WorkspaceFixture {
  id: string;
  memberId: string;
}

async function createWorkspace(
  ownerUserId: string,
  ownerEmail: string,
  label: string,
): Promise<WorkspaceFixture> {
  const team = await prisma.team.create({
    data: { name: `Assets search ${label} ${randomUUID()}` },
    select: { id: true },
  });
  fixtureWorkspaceIds.push(team.id);
  await prisma.workspace.create({
    data: { id: team.id, name: `Assets search ${label}`, ownerUserId },
  });
  const member = await prisma.workspaceMember.create({
    data: {
      workspaceId: team.id,
      email: ownerEmail,
      role: 'admin',
      status: 'active',
      invitedByUserId: ownerUserId,
      userId: ownerUserId,
      joinedAt: new Date(),
    },
    select: { id: true },
  });
  return { id: team.id, memberId: member.id };
}

async function createAlert(workspace: WorkspaceFixture, host: string) {
  const scan = await prisma.scan.create({
    data: {
      target: host,
      status: 'completed',
      teamId: workspace.id,
      startedAt: new Date(),
    },
    select: { id: true },
  });
  const asset = await prisma.asset.create({
    data: {
      scanId: scan.id,
      host,
      ip: '192.0.2.42',
      port: 443,
      protocol: 'tcp',
      state: 'open',
      serviceHint: 'https',
    },
    select: { id: true },
  });
  const finding = await prisma.vulnerabilityFinding.create({
    data: {
      scanId: scan.id,
      assetId: asset.id,
      cveId: `CVE-2026-${Math.floor(Math.random() * 89999) + 10000}`,
      severity: 'high',
      matchReason: 'Synthetic asset-search fixture',
      priorityScore: 75,
      epssScore: 0.42,
      epssPercentile: 0.91,
      kevListed: true,
    },
    select: { id: true },
  });
  await prisma.alert.create({
    data: {
      teamId: workspace.id,
      findingId: finding.id,
      severity: 'high',
      source: 'kev',
      ownerId: workspace.memberId,
      status: 'open',
    },
  });
}

async function selectWorkspace(page: import('@playwright/test').Page, workspaceId: string) {
  const response = await page.evaluate(async (id) => {
    const result = await fetch('/api/workspace/active', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: id }),
    });
    return { status: result.status, body: await result.json() };
  }, workspaceId);
  expect(response).toEqual({ status: 200, body: { workspaceId } });
}
