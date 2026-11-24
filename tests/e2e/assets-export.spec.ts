// @polsia:user-owned — Authenticated assets CSV export journey.
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { expect, test } from '@playwright/test';

const prisma = new PrismaClient();
const token = randomUUID();
const email = `assets-export-${token}@example.invalid`;
const fixtureWorkspaceIds: string[] = [];
let userId: string | undefined;

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
      if (membership?.teamId) workspaceIds.add(membership.teamId);

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

test('exports all filtered assets from the active member workspace and handles empty and anonymous requests', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);

  await page.goto('/signup');
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic CSV Export Passphrase!23');
  await page.getByLabel('Confirm password').fill('Synthetic CSV Export Passphrase!23');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\/|$)/, { timeout: 30_000 });

  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true, email: true },
  });
  userId = user.id;

  const active = await createWorkspace(user.id, user.email, 'active-member');
  const other = await createWorkspace(user.id, user.email, 'other-member');
  const viewer = await createViewerWorkspace(user.id, user.email);
  const now = Date.now();
  const alphaHost = `export-${token}-alpha.example.invalid`;
  const bravoHost = `export-${token}-bravo.example.invalid`;
  const tieHost = `export-${token}-charlie.example.invalid`;
  const fallingHost = `export-${token}-falling.example.invalid`;
  const unresolvedHost = `export-${token}-unresolved.example.invalid`;
  const lowScoreHost = `export-${token}-low-score.example.invalid`;
  const lowSeverityHost = `export-${token}-low-severity.example.invalid`;
  const otherWorkspaceHost = `export-${token}-other-workspace.example.invalid`;

  await createAsset(active, alphaHost, new Date(now - 8 * DAY), 2, 'high', 'resolved');
  await createAsset(active, alphaHost, new Date(now - 4 * 60 * 60 * 1000), 8, 'high', 'resolved');
  await createAsset(active, bravoHost, new Date(now - 8 * DAY), 3, 'high', 'resolved');
  await createAsset(active, bravoHost, new Date(now - DAY), 8, 'high', 'resolved');
  await createAsset(active, tieHost, new Date(now - 8 * DAY), 4, 'high', 'resolved');
  await createAsset(active, tieHost, new Date(now - DAY), 8, 'high', 'resolved');
  await createAsset(active, fallingHost, new Date(now - 8 * DAY), 9, 'high', 'resolved');
  await createAsset(active, fallingHost, new Date(now - DAY), 6, 'high', 'resolved');
  const unresolvedFinding = await createAsset(
    active,
    unresolvedHost,
    new Date(now - DAY),
    8,
    'high',
    'resolved',
  );
  await createAlert(active, unresolvedFinding.findingId, 'open', 'high');
  await createAsset(active, lowScoreHost, new Date(now - DAY), 5, 'high', 'resolved');
  await createAsset(active, lowSeverityHost, new Date(now - DAY), 8, 'low', 'resolved');
  await createAsset(other, otherWorkspaceHost, new Date(now - DAY), 8, 'high', 'resolved');

  await selectWorkspace(page, active.id);
  await page.goto(
    `/assets?q=export-${token}&severity=high&status=resolved&minRiskScore=6.5&scanRecency=last30d&riskTrend=rising&alertPresence=without&sort=latestScanAt%3Aasc&pageSize=1`,
  );
  await expect(page.getByRole('heading', { name: 'Assets' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toHaveCount(0);
  await expect(page.getByRole('link', { name: bravoHost })).toBeVisible();
  await expect(page.getByRole('link', { name: alphaHost })).toHaveCount(0);
  await expect(page.getByRole('link', { name: tieHost })).toHaveCount(0);
  await expect(page.getByRole('link', { name: fallingHost })).toHaveCount(0);

  let postedBody: unknown;
  page.on('request', (browserRequest) => {
    if (
      browserRequest.url().includes('/api/assets/export.csv') &&
      browserRequest.method() === 'POST'
    ) {
      postedBody = browserRequest.postDataJSON();
    }
  });
  const [exportResponse, download] = await Promise.all([
    page.waitForResponse((response) => response.url().includes('/api/assets/export.csv')),
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export CSV' }).click(),
  ]).then(([response, file]) => [response, file] as const);
  const exported = await exportResponse.json();
  expect(exported).toMatchObject({ ok: true, data: { records: 3 } });
  expect(download.suggestedFilename()).toBe('vulnaware-assets.csv');
  expect(postedBody).toEqual({
    sourceId: 'vulnaware-assets',
    delimiter: ',',
    filters: {
      sort: 'latestScanAt:asc',
      q: `export-${token}`,
      severity: 'high',
      status: 'resolved',
      minRiskScore: '6.5',
      scanRecency: 'last30d',
      riskTrend: 'rising',
      alertPresence: 'without',
    },
  });
  const dataLines = String(exported.data.csv)
    .replace(/^\uFEFF/, '')
    .trimEnd()
    .split('\r\n')
    .slice(1);
  const exportedHosts = dataLines.map((line) => {
    const cells = line.split(',');
    return cells[6]?.replace(/^"'|"$/g, '');
  });
  expect(exportedHosts).toEqual([bravoHost, tieHost, alphaHost]);
  expect(String(exported.data.csv)).not.toContain(otherWorkspaceHost);
  expect(String(exported.data.csv)).not.toContain(unresolvedHost);
  expect(String(exported.data.csv)).not.toContain(fallingHost);
  expect(String(exported.data.csv)).not.toContain(lowScoreHost);
  expect(String(exported.data.csv)).not.toContain(lowSeverityHost);
  await page.screenshot({ path: testInfo.outputPath('assets-export-desktop.png') });

  const clientWorkspaceAttempt = await page.evaluate(async (workspaceId) => {
    const response = await fetch('/api/assets/export.csv', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceId: 'vulnaware-assets',
        filters: { workspaceId },
      }),
    });
    return { status: response.status, body: await response.json() };
  }, other.id);
  expect(clientWorkspaceAttempt).toMatchObject({
    status: 400,
    body: { ok: false, error: { code: 'INVALID_FILTERS' } },
  });

  await page.goto(`/assets?q=missing-${token}`);
  const exportButton = page.getByRole('button', { name: 'Export CSV' });
  await expect(exportButton).toBeEnabled();
  await exportButton.click();
  await expect(
    page.getByText('Aucun résultat à exporter avec ces filtres.', { exact: true }),
  ).toBeVisible();

  await selectWorkspace(page, viewer.id);
  const viewerDenial = await page.evaluate(async () => {
    const response = await fetch('/api/assets/export.csv', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId: 'vulnaware-assets', filters: {} }),
    });
    return { status: response.status, body: await response.json() };
  });
  expect(viewerDenial).toEqual({
    status: 403,
    body: {
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Vous ne pouvez pas exporter cette source ou ces champs.',
      },
    },
  });

  const baseUrl = process.env.BASE_URL;
  if (!baseUrl) throw new Error('BASE_URL is required for the anonymous export check');
  const anonymousResponse = await request.post(`${baseUrl}/api/assets/export.csv`, {
    headers: { origin: new URL(baseUrl).origin },
    data: { sourceId: 'vulnaware-assets', filters: {} },
  });
  expect(anonymousResponse.status()).toBe(401);
  expect(await anonymousResponse.json()).toMatchObject({
    ok: false,
    error: { code: 'UNAUTHENTICATED' },
  });

  await selectWorkspace(page, active.id);
  await page.goto(
    `/assets?q=export-${token}&severity=high&status=resolved&minRiskScore=6.5&scanRecency=last30d&riskTrend=rising&alertPresence=without&sort=latestScanAt%3Aasc&pageSize=1`,
  );
  await expect(page.getByRole('link', { name: bravoHost })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Export CSV' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Export CSV' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('assets-export-mobile.png') });

  const largeHost = `export-${token}-large-supporting-history.example.invalid`;
  await createLargeSupportingHistory(active, largeHost);
  const largeSupportingExport = await page.evaluate(async (host) => {
    const response = await fetch('/api/assets/export.csv', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceId: 'vulnaware-assets',
        filters: { q: host, riskTrend: 'rising', sort: 'riskScoreChange' },
      }),
    });
    return { status: response.status, body: await response.json() };
  }, largeHost);
  expect(largeSupportingExport).toMatchObject({
    status: 200,
    body: { ok: true, data: { records: 1 } },
  });
  expect(largeSupportingExport.body.data.csv).toContain(largeHost);
  expect(largeSupportingExport.body.data.csv).toContain(String(LARGE_SUPPORTING_ROW_COUNT));
  await page.screenshot({ path: testInfo.outputPath('assets-export-large-history.png') });

  const candidateLimitHost = `export-${token}-candidate-10000.example.invalid`;
  await createCandidateLimitRows(active);
  const filteredCandidateExport = await page.evaluate(async (query) => {
    const response = await fetch('/api/assets/export.csv', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceId: 'vulnaware-assets',
        filters: { q: query, minRiskScore: '8.5', sort: 'name' },
      }),
    });
    return { status: response.status, body: await response.json() };
  }, `export-${token}-candidate`);
  expect(filteredCandidateExport).toMatchObject({
    status: 200,
    body: { ok: true, data: { records: 1 } },
  });
  expect(filteredCandidateExport.body.data.csv).toContain(candidateLimitHost);

  const overLimitAssetExport = await page.evaluate(async (query) => {
    const response = await fetch('/api/assets/export.csv', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceId: 'vulnaware-assets',
        filters: { q: query, sort: 'name' },
      }),
    });
    return { status: response.status, body: await response.json() };
  }, `export-${token}-candidate`);
  expect(overLimitAssetExport).toMatchObject({
    status: 413,
    body: { ok: false, error: { code: 'ROW_LIMIT' } },
  });
});

const DAY = 24 * 60 * 60 * 1000;
const LARGE_SUPPORTING_ROW_COUNT = 10_001;
const CANDIDATE_HOST_COUNT = 10_001;

async function createWorkspace(ownerUserId: string, ownerEmail: string, label: string) {
  const team = await prisma.team.create({
    data: { name: `CSV export ${label} ${token}` },
    select: { id: true },
  });
  fixtureWorkspaceIds.push(team.id);
  await prisma.workspace.create({
    data: { id: team.id, name: `CSV export ${label}`, ownerUserId },
  });
  const member = await prisma.workspaceMember.create({
    data: {
      workspaceId: team.id,
      email: ownerEmail,
      role: 'member',
      status: 'active',
      invitedByUserId: ownerUserId,
      userId: ownerUserId,
      joinedAt: new Date(),
    },
    select: { id: true },
  });
  return { id: team.id, memberId: member.id };
}

async function createViewerWorkspace(ownerUserId: string, ownerEmail: string) {
  const team = await prisma.team.create({
    data: { name: `CSV export viewer ${token}` },
    select: { id: true },
  });
  fixtureWorkspaceIds.push(team.id);
  await prisma.workspace.create({
    data: { id: team.id, name: `CSV export viewer ${token}` },
  });
  await prisma.workspaceMember.create({
    data: {
      workspaceId: team.id,
      email: ownerEmail,
      role: 'viewer',
      status: 'active',
      invitedByUserId: ownerUserId,
      userId: ownerUserId,
      joinedAt: new Date(),
    },
  });
  return { id: team.id };
}

async function createAsset(
  workspace: { id: string; memberId: string },
  host: string,
  startedAt: Date,
  priorityScore: number,
  severity: string,
  status: 'open' | 'resolved',
) {
  const scan = await prisma.scan.create({
    data: { target: host, status: 'completed', teamId: workspace.id, startedAt },
    select: { id: true },
  });
  const asset = await prisma.asset.create({
    data: {
      scanId: scan.id,
      host,
      ip: '192.0.2.88',
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
      cveId: `CVE-${token.slice(0, 8)}-${randomUUID().slice(0, 8)}`,
      severity,
      matchReason: 'Synthetic CSV export fixture',
      priorityScore,
      epssScore: 0.42,
      epssPercentile: 0.91,
      kevListed: true,
    },
    select: { id: true },
  });
  await createAlert(workspace, finding.id, status, severity);
  return { findingId: finding.id };
}

async function createAlert(
  workspace: { id: string; memberId: string },
  findingId: string,
  status: 'open' | 'resolved',
  severity: string,
) {
  await prisma.alert.create({
    data: {
      teamId: workspace.id,
      findingId,
      severity,
      source: 'kev',
      ownerId: workspace.memberId,
      status,
    },
  });
}

async function createLargeSupportingHistory(
  workspace: { id: string; memberId: string },
  host: string,
) {
  const startedAt = Date.now() - 2 * DAY;
  const scans = Array.from({ length: LARGE_SUPPORTING_ROW_COUNT }, (_, index) => ({
    id: `large-scan-${token}-${String(index).padStart(5, '0')}`,
    target: host,
    status: 'completed',
    teamId: workspace.id,
    startedAt: new Date(startedAt + index * 1_000),
  }));
  const assets = scans.map((scan, index) => ({
    id: `large-asset-${token}-${String(index).padStart(5, '0')}`,
    scanId: scan.id,
    host,
    ip: '192.0.2.89',
    port: 443,
    state: 'open',
    serviceHint: 'https',
  }));
  const findings = scans.map((scan, index) => ({
    id: `large-finding-${token}-${String(index).padStart(5, '0')}`,
    scanId: scan.id,
    assetId: assets[index]?.id ?? '',
    cveId: `CVE-LARGE-${token}-${String(index).padStart(5, '0')}`,
    severity: 'high',
    matchReason: 'Synthetic large-history export fixture',
    priorityScore: 1 + (9 * index) / (LARGE_SUPPORTING_ROW_COUNT - 1),
    epssScore: 0.42,
    epssPercentile: 0.91,
    kevListed: true,
  }));
  const alerts = findings.map((finding) => ({
    id: `large-alert-${token}-${finding.id.slice(-5)}`,
    teamId: workspace.id,
    findingId: finding.id,
    severity: 'high',
    source: 'kev' as const,
    ownerId: workspace.memberId,
    status: 'open' as const,
  }));

  async function createInBatches<T>(
    rows: T[],
    create: (batch: T[]) => Promise<unknown>,
  ) {
    for (let offset = 0; offset < rows.length; offset += 500) {
      await create(rows.slice(offset, offset + 500));
    }
  }

  await createInBatches(scans, (data) => prisma.scan.createMany({ data }));
  await createInBatches(assets, (data) => prisma.asset.createMany({ data }));
  await createInBatches(findings, (data) => prisma.vulnerabilityFinding.createMany({ data }));
  await createInBatches(alerts, (data) => prisma.alert.createMany({ data }));
}

async function createCandidateLimitRows(workspace: { id: string; memberId: string }) {
  const suffix = token.replaceAll('-', '').slice(0, 12);
  const scanId = `candidate-scan-${suffix}`;
  await prisma.scan.create({
    data: {
      id: scanId,
      target: `candidate-${suffix}.example.invalid`,
      status: 'completed',
      teamId: workspace.id,
      startedAt: new Date(Date.now() - DAY),
    },
  });

  const assets = Array.from({ length: CANDIDATE_HOST_COUNT }, (_, index) => {
    const ordinal = String(index).padStart(5, '0');
    return {
      id: `candidate-asset-${suffix}-${ordinal}`,
      scanId,
      host: `export-${token}-candidate-${ordinal}.example.invalid`,
      ip: '192.0.2.90',
      port: 443,
      state: 'open',
      serviceHint: 'https',
    };
  });
  const findings = assets.map((asset, index) => {
    const ordinal = String(index).padStart(5, '0');
    return {
      id: `candidate-finding-${suffix}-${ordinal}`,
      scanId,
      assetId: asset.id,
      cveId: `CVE-CAND-${suffix}-${ordinal}`,
      severity: 'high',
      matchReason: 'Synthetic CSV export candidate fixture',
      priorityScore: index === CANDIDATE_HOST_COUNT - 1 ? 9 : 4,
      epssScore: 0.42,
      epssPercentile: 0.91,
      kevListed: true,
    };
  });
  const alerts = findings.map((finding, index) => ({
    id: `candidate-alert-${suffix}-${String(index).padStart(5, '0')}`,
    teamId: workspace.id,
    findingId: finding.id,
    severity: 'high',
    source: 'kev' as const,
    ownerId: workspace.memberId,
    status: 'resolved' as const,
  }));

  async function createInBatches<T>(rows: T[], create: (batch: T[]) => Promise<unknown>) {
    for (let offset = 0; offset < rows.length; offset += 500) {
      await create(rows.slice(offset, offset + 500));
    }
  }

  await createInBatches(assets, (data) => prisma.asset.createMany({ data }));
  await createInBatches(findings, (data) => prisma.vulnerabilityFinding.createMany({ data }));
  await createInBatches(alerts, (data) => prisma.alert.createMany({ data }));
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
