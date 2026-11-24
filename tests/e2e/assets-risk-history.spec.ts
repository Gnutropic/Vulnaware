// @polsia:user-owned — Authenticated browser journey for persisted scan history.

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { expect, test } from '@playwright/test';

const prisma = new PrismaClient();
const email = `asset-risk-history-${randomUUID()}@example.invalid`;
const passphrase = 'Synthetic Asset History Passphrase!23';
const host = `risk-history-${randomUUID().slice(0, 8)}.example.invalid`;
const emptyHost = `risk-history-empty-${randomUUID().slice(0, 8)}.example.invalid`;
const teamIds = new Set<string>();
const cveIds: string[] = [];
let userId: string | undefined;
let ownedTeamId: string | undefined;

test.afterAll(async () => {
  try {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    userId ??= user?.id;
    if (userId) {
      const membership = await prisma.membership.findUnique({
        where: { userId },
        select: { teamId: true },
      });
      ownedTeamId ??= membership?.teamId;
      if (ownedTeamId) teamIds.add(ownedTeamId);
      await prisma.session.deleteMany({ where: { userId } });
      await prisma.account.deleteMany({ where: { userId } });
      await prisma.membership.deleteMany({ where: { userId } });
      await prisma.userSubscription.deleteMany({ where: { userId } });
      await prisma.dailyDigestPrefs.deleteMany({ where: { userId } });
    }

    if (teamIds.size > 0) {
      const ids = [...teamIds];
      await prisma.alert.deleteMany({ where: { teamId: { in: ids } } });
      await prisma.scan.deleteMany({ where: { teamId: { in: ids } } });
      await prisma.trialWorkspace.deleteMany({ where: { teamId: { in: ids } } });
      await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: ids } } });
      await prisma.workspace.deleteMany({ where: { id: { in: ids } } });
      await prisma.team.deleteMany({ where: { id: { in: ids } } });
    }
    if (cveIds.length > 0) await prisma.cveEntry.deleteMany({ where: { cveId: { in: cveIds } } });
    if (userId) {
      await prisma.workspaceMember.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  } finally {
    await prisma.$disconnect();
  }
});

test('asset detail renders dated scan risk scores and an empty no-history state', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto('/signup');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(passphrase);
  await page.getByLabel('Confirm password').fill(passphrase);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\/|$)/, { timeout: 30_000 });

  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true, email: true },
  });
  userId = user.id;
  const membership = await prisma.membership.findUniqueOrThrow({
    where: { userId: user.id },
    select: { teamId: true },
  });
  ownedTeamId = membership.teamId;
  teamIds.add(ownedTeamId);
  const owner = await prisma.workspaceMember.findFirstOrThrow({
    where: { workspaceId: ownedTeamId, userId: user.id, status: 'active' },
    select: { id: true },
  });

  const now = new Date();
  const expectedPoints = [
    { scannedAt: daysBefore(now, 25), score: 4.2 },
    { scannedAt: daysBefore(now, 12), score: 8.8 },
    { scannedAt: daysBefore(now, 3), score: 6.1 },
  ];
  await createScan(ownedTeamId, owner.id, host, expectedPoints[0]?.scannedAt ?? now, [4.2]);
  await createScan(ownedTeamId, owner.id, host, expectedPoints[1]?.scannedAt ?? now, [5.4, 8.8]);
  await createScan(ownedTeamId, owner.id, host, expectedPoints[2]?.scannedAt ?? now, [6.1]);
  await createScan(ownedTeamId, owner.id, host, daysBefore(now, 5), [null]);
  await createScan(ownedTeamId, owner.id, host, daysBefore(now, 31), [9.9]);
  await createScan(ownedTeamId, owner.id, `${host}.other`, daysBefore(now, 2), [9.7]);

  const otherTeam = await prisma.team.create({
    data: { name: `Asset history isolation ${randomUUID()}` },
    select: { id: true },
  });
  teamIds.add(otherTeam.id);
  await createScan(otherTeam.id, null, host, daysBefore(now, 1), [10]);

  await createScan(ownedTeamId, owner.id, emptyHost, daysBefore(now, 2), [null]);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/assets/${encodeURIComponent(host)}`);
  const trendCard = page.getByTestId('asset-risk-trend');
  await expect(trendCard).toBeVisible({ timeout: 30_000 });
  await expect(trendCard).toContainText('over the last 30 days');
  const sparkline = trendCard.getByTestId('asset-risk-trend-spark');
  await expect(sparkline).toBeVisible();
  const plottedPath = sparkline.locator('svg path');
  await expect(plottedPath).toBeVisible();
  const pathData = await plottedPath.getAttribute('d');
  const plottedYValues = [...(pathData ?? '').matchAll(/,([\d.]+)/g)].map((match) => match[1]);
  expect(plottedYValues).toHaveLength(expectedPoints.length);
  expect(new Set(plottedYValues).size).toBeGreaterThan(1);

  const points = trendCard.getByTestId('asset-risk-trend-point');
  await expect(points).toHaveCount(expectedPoints.length);
  for (const [position, expected] of [...expectedPoints].reverse().entries()) {
    const point = points.nth(position);
    await expect(point.locator('time')).toHaveAttribute('datetime', expected.scannedAt.toISOString());
    await expect(point).toContainText(`Score ${expected.score}`);
  }

  const apiResult = await page.evaluate(async (path) => {
    const response = await fetch(path);
    return { status: response.status, body: await response.json() };
  }, `/api/assets/${encodeURIComponent(host)}/risk-trend`);
  expect(apiResult).toEqual({
    status: 200,
    body: {
      host,
      series: expectedPoints.map(({ scannedAt, score }) => ({
        scannedAt: scannedAt.toISOString(),
        score,
      })),
    },
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(trendCard).toBeVisible();
  await expect(sparkline).toBeVisible();
  await expect(points).toHaveCount(expectedPoints.length);

  await page.goto(`/assets/${encodeURIComponent(emptyHost)}`);
  const emptyCard = page.getByTestId('asset-risk-trend-empty');
  await expect(emptyCard).toBeVisible({ timeout: 30_000 });
  await expect(emptyCard).toContainText('Last 30 days');
  await expect(emptyCard).toContainText('No dated risk scores are available');
  const emptyApiResult = await page.evaluate(async (path) => {
    const response = await fetch(path);
    return { status: response.status, body: await response.json() };
  }, `/api/assets/${encodeURIComponent(emptyHost)}/risk-trend`);
  expect(emptyApiResult).toEqual({ status: 200, body: { host: emptyHost, series: [] } });
});

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

async function createScan(
  teamId: string,
  ownerId: string | null,
  scanHost: string,
  startedAt: Date,
  scores: Array<number | null>,
): Promise<void> {
  const scan = await prisma.scan.create({
    data: { target: scanHost, status: 'completed', teamId, startedAt },
    select: { id: true },
  });
  const asset = await prisma.asset.create({
    data: {
      scanId: scan.id,
      host: scanHost,
      ip: '192.0.2.85',
      port: 443,
      protocol: 'tcp',
      state: 'open',
    },
    select: { id: true },
  });

  for (const priorityScore of scores) {
    const cveId = `CVE-SYNTH-${randomUUID()}`;
    cveIds.push(cveId);
    const finding = await prisma.vulnerabilityFinding.create({
      data: {
        scanId: scan.id,
        assetId: asset.id,
        cveId,
        severity: 'high',
        matchReason: 'Synthetic scan history fixture',
        priorityScore,
      },
      select: { id: true },
    });
    await prisma.alert.create({
      data: {
        teamId,
        findingId: finding.id,
        severity: 'high',
        source: 'kev',
        ownerId,
        createdAt: startedAt,
      },
      select: { id: true },
    });
  }
}
