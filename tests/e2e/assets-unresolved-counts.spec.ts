// @polsia:user-owned — Authenticated /assets unresolved-count regression coverage.
import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { PrismaClient } from '@prisma/client';
import { expect, test } from '@playwright/test';

const prisma = new PrismaClient();
const email = `assets-counts-${randomUUID()}@example.invalid`;
const password = 'Synthetic Asset Counts Passphrase!23';
const fixtureWorkspaceIds: string[] = [];
let userId: string | undefined;

type WorkspaceFixture = { id: string };
type AlertFixtureStatus = 'open' | 'in_progress' | 'resolved';
type AlertFixtureSeverity = 'critical' | 'high' | 'low';
type AssetListResponse = {
  items: Array<{ name: string; unresolvedCount: number }>;
  total: number;
};

test.afterAll(async () => {
  try {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    userId ??= user?.id;

    const workspaceIds = new Set(fixtureWorkspaceIds);
    if (userId) {
      const [membership, ownedWorkspaces] = await Promise.all([
        prisma.membership.findUnique({ where: { userId }, select: { teamId: true } }),
        prisma.workspace.findMany({ where: { ownerUserId: userId }, select: { id: true } }),
      ]);
      if (membership) workspaceIds.add(membership.teamId);
      for (const workspace of ownedWorkspaces) workspaceIds.add(workspace.id);

      await prisma.session.deleteMany({ where: { userId } });
      await prisma.account.deleteMany({ where: { userId } });
      await prisma.userSubscription.deleteMany({ where: { userId } });
      await prisma.dailyDigestPrefs.deleteMany({ where: { userId } });
      await prisma.membership.deleteMany({ where: { userId } });
    }

    if (workspaceIds.size > 0) {
      const ids = [...workspaceIds];
      await prisma.alert.deleteMany({ where: { teamId: { in: ids } } });
      await prisma.trialWorkspace.deleteMany({ where: { teamId: { in: ids } } });
      await prisma.scan.deleteMany({ where: { teamId: { in: ids } } });
      await prisma.workspaceMember.deleteMany({
        where: { OR: [{ workspaceId: { in: ids } }, ...(userId ? [{ userId }] : [])] },
      });
      await prisma.workspace.deleteMany({ where: { id: { in: ids } } });
      await prisma.team.deleteMany({ where: { id: { in: ids } } });
    }
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  } finally {
    await prisma.$disconnect();
  }
});

test('shows active-workspace unresolved counts on desktop and mobile across filters and pages', async ({
  page,
}) => {
  test.setTimeout(120_000);

  const userIdValue = randomUUID();
  const now = new Date();
  await prisma.user.create({
    data: {
      id: userIdValue,
      name: 'Synthetic Asset Counts Member',
      email,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
  });
  userId = userIdValue;
  await prisma.account.create({
    data: {
      id: randomUUID(),
      accountId: email,
      providerId: 'credential',
      userId: userIdValue,
      password: await hashPassword(password),
      createdAt: now,
      updatedAt: now,
    },
  });

  const active = await createWorkspace(userIdValue, email, 'active');
  await prisma.membership.create({
    data: { userId: userIdValue, teamId: active.id, role: 'member' },
  });
  const requested = await createWorkspace(userIdValue, email, 'requested');
  const token = randomUUID();
  const activeHost = `count-a-${token}.example.invalid`;
  const zeroHost = `count-b-${token}.example.invalid`;
  const requestedOnlyHost = `count-requested-${token}.example.invalid`;

  await createAlert(active, activeHost, 'resolved', 'high');
  await createAlert(active, activeHost, 'open', 'low');
  await createAlert(active, activeHost, 'in_progress', 'critical');
  await createAlert(active, zeroHost, 'resolved', 'high');

  // This same-host count and host row belong only to the workspace named by
  // the client query. The active cookie must remain the inventory's scope.
  for (const status of ['open', 'open', 'in_progress', 'in_progress'] as const) {
    await createAlert(requested, activeHost, status, 'high');
  }
  await createAlert(requested, requestedOnlyHost, 'resolved', 'high');

  await page.goto('/login');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\/|$)/, { timeout: 30_000 });

  await selectWorkspace(page, active.id);

  const query = `severity=high&status=resolved&sort=name&pageSize=1&workspaceId=${encodeURIComponent(requested.id)}`;
  const pageOnePath = `/api/assets?${query}&page=1`;
  const firstPageResponse = await page.evaluate(async (path) => {
    const response = await fetch(path);
    return {
      status: response.status,
      body: (await response.json()) as AssetListResponse,
    };
  }, pageOnePath);
  expect(firstPageResponse.status).toBe(200);
  expect(firstPageResponse.body).toMatchObject({
    items: [expect.objectContaining({ name: activeHost, unresolvedCount: 2 })],
    total: 2,
  });

  const pageTwoResponse = await page.evaluate(async (path) => {
    const response = await fetch(path);
    return {
      status: response.status,
      body: (await response.json()) as AssetListResponse,
    };
  }, `/api/assets?${query}&page=2`);
  expect(pageTwoResponse.status).toBe(200);
  expect(pageTwoResponse.body).toMatchObject({
    items: [expect.objectContaining({ name: zeroHost, unresolvedCount: 0 })],
    total: 2,
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/assets?${query}&page=1`);
  const desktopHostRow = page.getByRole('row').filter({ hasText: activeHost });
  await expect(desktopHostRow.getByRole('link', { name: activeHost })).toBeVisible();
  await expect(desktopHostRow.getByText('Unresolved alerts 2', { exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/polsia-assets-count-desktop.png', fullPage: true });
  await page.goto(`/assets?${query}&page=2`);
  const desktopZeroHostRow = page.getByRole('row').filter({ hasText: zeroHost });
  await expect(desktopZeroHostRow.getByText('Unresolved alerts 0', { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/assets?${query}&page=1`);
  const mobileHostCard = page.getByRole('listitem').filter({ hasText: activeHost });
  await expect(mobileHostCard.getByRole('link', { name: activeHost })).toBeVisible();
  await expect(mobileHostCard.getByText('Unresolved alerts 2', { exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/polsia-assets-count-mobile.png', fullPage: true });

  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(`/assets?${query}&page=1`);
  const narrowHostCard = page.getByRole('listitem').filter({ hasText: activeHost });
  await expect(narrowHostCard.getByText('Unresolved alerts 2', { exact: true })).toBeVisible();
  const narrowHostBounds = await narrowHostCard.getByRole('link', { name: activeHost }).boundingBox();
  if (narrowHostBounds === null) throw new Error('Expected the host link to have a visible box.');
  expect(narrowHostBounds.x + narrowHostBounds.width).toBeLessThanOrEqual(320);
  await page.screenshot({ path: '/tmp/polsia-assets-count-mobile-320.png', fullPage: true });

  await page.goto(`/assets?${query}&page=2`);
  const mobileZeroHostCard = page.getByRole('listitem').filter({ hasText: zeroHost });
  await expect(mobileZeroHostCard.getByRole('link', { name: zeroHost })).toBeVisible();
  await expect(mobileZeroHostCard.getByText('Unresolved alerts 0', { exact: true })).toBeVisible();
});

async function createWorkspace(
  ownerUserId: string,
  ownerEmail: string,
  label: string,
): Promise<WorkspaceFixture> {
  const name = `Asset count ${label} ${randomUUID()}`;
  const team = await prisma.team.create({ data: { name }, select: { id: true } });
  fixtureWorkspaceIds.push(team.id);
  await prisma.workspace.create({
    data: { id: team.id, name, ownerUserId },
  });
  await prisma.workspaceMember.create({
    data: {
      workspaceId: team.id,
      email: ownerEmail,
      role: 'member',
      status: 'active',
      invitedByUserId: ownerUserId,
      userId: ownerUserId,
      joinedAt: new Date(),
    },
  });
  return { id: team.id };
}

async function createAlert(
  workspace: WorkspaceFixture,
  host: string,
  status: AlertFixtureStatus,
  severity: AlertFixtureSeverity,
): Promise<void> {
  const scan = await prisma.scan.create({
    data: { target: host, status: 'completed', teamId: workspace.id, startedAt: new Date() },
    select: { id: true },
  });
  const asset = await prisma.asset.create({
    data: {
      scanId: scan.id,
      host,
      ip: '192.0.2.57',
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
      severity,
      matchReason: 'Synthetic asset alert count fixture',
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
      severity,
      source: 'kev',
      status,
    },
  });
}

async function selectWorkspace(page: import('@playwright/test').Page, workspaceId: string) {
  const result = await page.evaluate(async (id) => {
    const response = await fetch('/api/workspace/active', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: id }),
    });
    return { status: response.status, body: await response.json() };
  }, workspaceId);
  expect(result).toEqual({ status: 200, body: { workspaceId } });
}
