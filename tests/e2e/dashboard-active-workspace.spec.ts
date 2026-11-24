// @polsia:user-owned — Real authenticated dashboard workspace-isolation journey.
import { randomInt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { expect, test } from '@playwright/test';

const prisma = new PrismaClient();
const email = `dashboard-workspace-${randomUUID()}@example.invalid`;
const detailCveId = `CVE-2026-${randomInt(10_000, 100_000)}`;
const detailDescription = 'Synthetic dashboard alert description for metadata isolation.';
const overviewEndpoints = [
  '/api/dashboard/aging',
  '/api/dashboard/mttr',
  '/api/dashboard/open-by-severity',
  '/api/dashboard/recent-activity',
  '/api/dashboard/recent-remediations',
  '/api/dashboard/scan-coverage',
  '/api/dashboard/summary',
  '/api/dashboard/top-assets',
  '/api/dashboard/top-cves',
  '/api/dashboard/top-cves-by-epss',
  '/api/dashboard/trend',
] as const;

interface AlertFixture {
  alertId: string;
  host: string;
  cveId: string;
}

interface WorkspaceFixture {
  id: string;
  memberId: string;
  alerts: AlertFixture[];
}

const fixtureWorkspaceIds: string[] = [];
const fixtureCveIds: string[] = [];
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
      await prisma.alert.deleteMany({ where: { teamId: { in: ids } } });
      await prisma.scan.deleteMany({ where: { teamId: { in: ids } } });
      await prisma.trialWorkspace.deleteMany({ where: { teamId: { in: ids } } });
      await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: ids } } });
      await prisma.workspace.deleteMany({ where: { id: { in: ids } } });
      await prisma.team.deleteMany({ where: { id: { in: ids } } });
    }
    if (fixtureCveIds.length > 0) {
      await prisma.cveEntry.deleteMany({ where: { cveId: { in: fixtureCveIds } } });
    }
    if (userId) await prisma.workspaceMember.deleteMany({ where: { userId } });
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  } finally {
    await prisma.$disconnect();
  }
});

test('dashboard overview; alert detail follows the active workspace', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.goto('/login');
  const anonymousExport = await page.evaluate(async () => {
    const response = await fetch('/api/alerts/export.csv', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId: 'vulnaware-alerts', filters: {} }),
    });
    return response.status;
  });
  expect(anonymousExport).toBe(401);

  await page.goto('/signup');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic Dashboard Passphrase!23');
  await page.getByLabel('Confirm password').fill('Synthetic Dashboard Passphrase!23');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\/|$)/, { timeout: 30_000 });

  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true, email: true },
  });
  userId = user.id;

  const firstWorkspace = await createWorkspace(user.id, user.email, 'first');
  const secondWorkspace = await createWorkspace(user.id, user.email, 'second');
  const emptyWorkspace = await createWorkspace(user.id, user.email, 'empty');
  const inaccessibleWorkspace = await createInaccessibleWorkspace();

  firstWorkspace.alerts.push(
    await createAlert(firstWorkspace, user.id, {
      label: 'first-open',
      host: 'first-open.dashboard.invalid',
      cveId: 'CVE-2026-81001',
      severity: 'critical',
      createdAt: daysAgo(100),
    }),
    await createAlert(firstWorkspace, user.id, {
      label: 'first-snoozed',
      host: 'first-snoozed.dashboard.invalid',
      cveId: 'CVE-2026-81002',
      severity: 'low',
      createdAt: daysAgo(1),
      snoozedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
    }),
    await createAlert(firstWorkspace, user.id, {
      label: 'first-remediated',
      host: 'first-remediated.dashboard.invalid',
      cveId: 'CVE-2026-81003',
      severity: 'high',
      createdAt: daysAgo(4),
      closedAt: daysAgo(2),
      remediatedAt: daysAgo(1),
    }),
  );
  secondWorkspace.alerts.push(
    await createAlert(secondWorkspace, user.id, {
      label: 'second-open-critical',
      host: 'second-critical.dashboard.invalid',
      cveId: detailCveId,
      description: detailDescription,
      severity: 'critical',
      createdAt: daysAgo(1),
    }),
    await createAlert(secondWorkspace, user.id, {
      label: 'second-open-old',
      host: 'second-old.dashboard.invalid',
      cveId: 'CVE-2026-82001',
      severity: 'high',
      createdAt: daysAgo(20),
    }),
    await createAlert(secondWorkspace, user.id, {
      label: 'second-open-medium',
      host: 'second-medium.dashboard.invalid',
      cveId: 'CVE-2026-82002',
      severity: 'medium',
      createdAt: daysAgo(3),
    }),
    await createAlert(secondWorkspace, user.id, {
      label: 'second-open-low',
      host: 'second-low.dashboard.invalid',
      cveId: 'CVE-2026-82003',
      severity: 'low',
      createdAt: daysAgo(2),
    }),
    await createAlert(secondWorkspace, user.id, {
      label: 'second-remediated',
      host: 'second-remediated.dashboard.invalid',
      cveId: 'CVE-2026-82004',
      severity: 'high',
      createdAt: daysAgo(5),
      closedAt: daysAgo(2),
      remediatedAt: daysAgo(1),
    }),
  );

  const anonymousResponses = await Promise.all(
    overviewEndpoints.map((endpoint) => request.get(endpoint)),
  );
  expect(anonymousResponses.map((response) => response.status())).toEqual(
    overviewEndpoints.map(() => 401),
  );

  const firstData = await visitWorkspace(page, firstWorkspace);
  expect(firstData['/api/dashboard/summary']?.body).toMatchObject({
    open: 2,
    ownedByMe: 3,
    snoozed: 1,
    resolvedThisWeek: 1,
  });
  expect(firstData['/api/dashboard/open-by-severity']?.body).toMatchObject({
    critical: 1,
    high: 0,
    medium: 0,
    low: 0,
  });
  expect(firstData['/api/dashboard/aging']?.body).toMatchObject({
    le7d: 1,
    d8to30: 0,
    d31to90: 0,
    gt90d: 1,
  });
  expect(firstData['/api/dashboard/scan-coverage']?.body).toMatchObject({
    totalHosts: 3,
    hostsWithOpenAlerts: 2,
  });
  expect(firstData['/api/dashboard/mttr']?.body).toMatchObject({ sampleSize: 1 });
  expect(firstData['/api/dashboard/top-assets']?.body).toMatchObject({
    items: [{ host: 'first-open.dashboard.invalid', count: 1 }],
  });
  expect(JSON.stringify(firstData['/api/dashboard/top-cves']?.body)).toContain('CVE-2026-81001');
  expect(JSON.stringify(firstData['/api/dashboard/top-cves']?.body)).toContain('CVE-2026-81003');
  expect(JSON.stringify(firstData['/api/dashboard/top-cves']?.body)).not.toContain(
    'CVE-2026-81002',
  );
  expect(JSON.stringify(firstData['/api/dashboard/top-cves-by-epss']?.body)).toContain(
    'CVE-2026-81001',
  );
  expect(JSON.stringify(firstData['/api/dashboard/top-cves-by-epss']?.body)).not.toContain(
    'CVE-2026-81002',
  );

  const secondData = await visitWorkspace(page, secondWorkspace);
  expect(secondData['/api/dashboard/summary']?.body).toMatchObject({
    open: 4,
    ownedByMe: 5,
    snoozed: 0,
    resolvedThisWeek: 1,
  });
  expect(secondData['/api/dashboard/open-by-severity']?.body).toMatchObject({
    critical: 1,
    high: 1,
    medium: 1,
    low: 1,
  });
  expect(secondData['/api/dashboard/aging']?.body).toMatchObject({
    le7d: 3,
    d8to30: 1,
    d31to90: 0,
    gt90d: 0,
  });
  expect(secondData['/api/dashboard/scan-coverage']?.body).toMatchObject({
    totalHosts: 5,
    hostsWithOpenAlerts: 4,
  });
  expect(secondData['/api/dashboard/mttr']?.body).toMatchObject({ sampleSize: 1 });
  expect(JSON.stringify(secondData['/api/dashboard/top-assets']?.body)).toContain(
    'second-old.dashboard.invalid',
  );
  expect(JSON.stringify(secondData['/api/dashboard/top-cves']?.body)).toContain('CVE-2026-82004');
  expect(JSON.stringify(secondData['/api/dashboard/top-cves-by-epss']?.body)).toContain(
    'CVE-2026-82003',
  );

  const resolvedHighFilters = 'status=resolved&severity=high';
  const resolvedHighAlerts = await readAlertList(page, resolvedHighFilters);
  expect(resolvedHighAlerts.status, JSON.stringify(resolvedHighAlerts.body)).toBe(200);
  expect(resolvedHighAlerts.body.items).toHaveLength(1);
  expect(resolvedHighAlerts.body.items[0]?.status).toBe('resolved');
  expect(resolvedHighAlerts.body.items.map((item) => item.asset.host)).toEqual([
    'second-remediated.dashboard.invalid',
  ]);

  await page.goto(`/alerts?${resolvedHighFilters}`);
  await expect(
    page.getByText('second-remediated.dashboard.invalid', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('second-old.dashboard.invalid', { exact: true })).toHaveCount(0);
  await expect(page.getByText('first-remediated.dashboard.invalid', { exact: true })).toHaveCount(0);

  await page.goto('/alerts');
  const resolvedChip = page.getByRole('button', { name: 'Resolved', exact: true });
  const ownerChip = page.getByRole('button', { name: 'Owned by me', exact: true });
  await expect(resolvedChip).toHaveCount(1);
  await ownerChip.click();
  await expect(ownerChip).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() => new URL(page.url()).searchParams.get('ownedByMe'))
    .toBe('1');
  await page.getByRole('button', { name: 'High', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('severity')).toBe('high');
  await resolvedChip.click();
  await expect.poll(() => new URL(page.url()).searchParams.get('status')).toBe('resolved');
  await expect(resolvedChip).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() => new URL(page.url()).searchParams.get('ownedByMe'))
    .toBe('1');
  await expect.poll(() => new URL(page.url()).searchParams.get('severity')).toBe('high');
  await expect(
    page.getByText('second-remediated.dashboard.invalid', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('first-remediated.dashboard.invalid', { exact: true })).toHaveCount(
    0,
  );

  await page.reload();
  await expect(resolvedChip).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByText('second-remediated.dashboard.invalid', { exact: true }),
  ).toBeVisible();
  await resolvedChip.click();
  await expect.poll(() => new URL(page.url()).searchParams.has('status')).toBe(false);
  await expect.poll(() => new URL(page.url()).searchParams.get('ownedByMe')).toBe('1');
  await expect.poll(() => new URL(page.url()).searchParams.get('severity')).toBe('high');
  const clearedAlerts = await readAlertList(page, new URL(page.url()).searchParams.toString());
  expect(clearedAlerts.status, JSON.stringify(clearedAlerts.body)).toBe(200);
  expect(clearedAlerts.body.items.map((item) => item.asset.host)).toContain(
    'second-old.dashboard.invalid',
  );
  await expect(page.getByText('second-old.dashboard.invalid', { exact: true })).toBeVisible();
  await expect(page.getByText('second-remediated.dashboard.invalid', { exact: true })).toHaveCount(
    0,
  );

  await page.getByRole('button', { name: 'High', exact: true }).click();
  await page.getByRole('button', { name: 'Critical', exact: true }).click();
  await resolvedChip.click();
  await expect.poll(() => new URL(page.url()).searchParams.get('status')).toBe('resolved');
  await expect(page.getByRole('cell', { name: 'No alerts yet.' })).toBeVisible();

  await page.setViewportSize({ width: 320, height: 800 });
  const severityWraps = await page
    .locator('fieldset[aria-label="Filter alerts by severity"]')
    .evaluate((fieldset) => {
      const rows = Array.from(fieldset.querySelectorAll('button')).map((button) =>
        Math.round(button.getBoundingClientRect().top),
      );
      return new Set(rows).size > 1;
    });
  expect(severityWraps).toBe(true);
  await expect(resolvedChip).toBeVisible();
  await resolvedChip.click();
  await expect.poll(() => new URL(page.url()).searchParams.has('status')).toBe(false);
  await expect(
    page.locator('ul:visible').getByText('second-critical.dashboard.invalid', { exact: false }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });

  await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      createAlert(secondWorkspace, user.id, {
        label: `second-export-page-${index}`,
        host: `second-export-page-${index}.dashboard.invalid`,
        cveId: `CVE-2026-${83000 + index}`,
        severity: 'critical',
        createdAt: daysAgo(index + 10),
      }),
    ),
  );

  const alertFilters = 'severity=critical&status=open&ownedByMe=1';
  const secondAlerts = await readAlertList(page, alertFilters);
  expect(secondAlerts.status, JSON.stringify(secondAlerts.body)).toBe(200);
  expect(secondAlerts.body.items).toHaveLength(50);
  const secondAlertsPageTwo = await readAlertList(page, `${alertFilters}&page=2`);
  expect(secondAlertsPageTwo.status).toBe(200);
  expect(secondAlertsPageTwo.body.items).toHaveLength(1);
  const allSecondAlertHosts = [...secondAlerts.body.items, ...secondAlertsPageTwo.body.items].map(
    (item) => item.asset.host,
  );
  expect(allSecondAlertHosts).toHaveLength(51);
  expect(allSecondAlertHosts).toContain('second-critical.dashboard.invalid');
  const workspaceScopeTamper = await page.evaluate(async ({ query, workspaceId }) => {
    const response = await fetch('/api/alerts/export.csv', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceId: 'vulnaware-alerts',
        filters: { ...Object.fromEntries(new URLSearchParams(query).entries()), workspaceId },
      }),
    });
    return response.status;
  }, { query: alertFilters, workspaceId: firstWorkspace.id });
  expect(workspaceScopeTamper).toBe(400);
  await page.goto(`/alerts?${alertFilters}`);
  await expect(page.getByText('second-critical.dashboard.invalid', { exact: true })).toBeVisible();
  await expect(page.getByText('first-open.dashboard.invalid', { exact: true })).toHaveCount(0);
  const secondCsv = await readAlertCsv(page, alertFilters);
  expect(secondCsv.status).toBe(200);
  expect(secondCsv.body).toContain('second-critical.dashboard.invalid');
  expect(secondCsv.body).not.toContain('first-open.dashboard.invalid');
  const exportButton = page.getByRole('button', { name: 'Export CSV' });
  await expect(exportButton).toBeEnabled();
  const secondDownloadPromise = page.waitForEvent('download');
  await exportButton.click();
  const secondDownload = await secondDownloadPromise;
  expect(secondDownload.suggestedFilename()).toBe('vulnaware-alerts.csv');
  const secondDownloadPath = await secondDownload.path();
  if (!secondDownloadPath) throw new Error('The workspace CSV download did not produce a file.');
  const secondDownloadCsv = await readFile(secondDownloadPath, 'utf8');
  const secondRecords = parseCsvRecords(secondDownloadCsv);
  const secondHeader = secondRecords[0] ?? [];
  expect(secondHeader).toEqual([
    '__polsia_format',
    '__polsia_source',
    '__polsia_schema',
    '__polsia_scope',
    '__polsia_key',
    '__polsia_version',
    'finding_title',
    'asset_host',
    'severity',
    'status',
    'cve_id',
    'opened_at',
    'last_activity_at',
    'snoozed_until',
  ]);
  const assetHostIndex = secondHeader.indexOf('asset_host');
  if (assetHostIndex < 0) throw new Error('The CSV has no asset_host column.');
  const downloadedSecondHosts = secondRecords.slice(1).map((record) => {
    const value = record[assetHostIndex] ?? '';
    return value === '\\N' ? null : value.startsWith("'") ? value.slice(1) : value;
  });
  expect(downloadedSecondHosts).toEqual(allSecondAlertHosts);
  expect(secondDownloadCsv).toContain('second-critical.dashboard.invalid');
  expect(secondDownloadCsv).not.toContain('first-open.dashboard.invalid');
  await page.reload();
  const reloadedSecondAlerts = await readAlertList(page, alertFilters);
  expect(reloadedSecondAlerts.status).toBe(200);
  expect(JSON.stringify(reloadedSecondAlerts.body)).not.toContain('first-open.dashboard.invalid');
  expect(JSON.stringify(reloadedSecondAlerts.body)).not.toContain('CVE-2026-81001');

  const detailAlert = secondWorkspace.alerts[0];
  if (!detailAlert) throw new Error('The synthetic detail alert was not created.');

  const anonymousDetailApi = await request.get(`/api/alerts/${detailAlert.alertId}`);
  expect(anonymousDetailApi.status()).toBe(401);

  const anonymousDetailPage = await request.get(`/alerts/${detailAlert.alertId}`);
  expect(anonymousDetailPage.status()).toBe(200);
  const anonymousHtml = await anonymousDetailPage.text();
  const headMarkup = anonymousHtml.split('<head')[1]?.split('</head>')[0] ?? '';
  expect(headMarkup).toContain('Alert details');
  expect(headMarkup).toContain('noindex');
  for (const privateValue of [detailAlert.host, detailAlert.cveId, detailDescription, 'critical']) {
    expect(headMarkup.toLowerCase()).not.toContain(privateValue.toLowerCase());
  }

  const authorizedDetailApi = await page.evaluate(async (alertId) => {
    const response = await fetch(`/api/alerts/${encodeURIComponent(alertId)}`);
    return { status: response.status, body: await response.json() };
  }, detailAlert.alertId);
  expect(authorizedDetailApi.status).toBe(200);
  expect(authorizedDetailApi.body).toMatchObject({
    cveId: detailAlert.cveId,
    description: detailDescription,
    asset: { host: detailAlert.host },
  });

  const detailPageErrors: string[] = [];
  page.on('pageerror', (error) => detailPageErrors.push(error.message));
  const detailPageConsoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') detailPageConsoleErrors.push(message.text());
  });
  await page.goto(`/alerts/${detailAlert.alertId}`);
  expect(detailPageErrors).toEqual([]);
  expect(detailPageConsoleErrors).toEqual([]);
  await expect(page.getByText(detailAlert.host, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(detailAlert.cveId, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(detailDescription, { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('alert-status')).toHaveText('Open');
  await expect(page.getByTestId('alert-mark-resolved-button')).toBeVisible();

  await page.getByTestId('alert-mark-resolved-button').click();
  await page.getByTestId('resolve-bulk-note-input').fill('Resolved from the active workspace.');
  await page.getByTestId('resolve-bulk-submit').click();
  await expect(page.getByTestId('alert-status')).toHaveText('Resolved');
  await expect(page.getByTestId('alert-mark-resolved-button')).toHaveCount(0);

  const resolvedDetailApi = await page.evaluate(async (alertId) => {
    const response = await fetch(`/api/alerts/${encodeURIComponent(alertId)}`);
    return { status: response.status, body: await response.json() };
  }, detailAlert.alertId);
  expect(resolvedDetailApi.status).toBe(200);
  expect(resolvedDetailApi.body).toMatchObject({
    id: detailAlert.alertId,
    status: 'resolved',
    closingNote: 'Resolved from the active workspace.',
  });
  const resolvedAlert = await prisma.alert.findUniqueOrThrow({
    where: { id: detailAlert.alertId },
    select: { status: true, closedAt: true, closedBy: true, closingNote: true },
  });
  expect(resolvedAlert.status).toBe('resolved');
  expect(resolvedAlert.closedAt).not.toBeNull();
  expect(resolvedAlert.closedBy).toBe(user.id);
  expect(resolvedAlert.closingNote).toBe('Resolved from the active workspace.');
  const alertBeforeDetailReads = await prisma.alert.findUniqueOrThrow({
    where: { id: detailAlert.alertId },
  });

  await selectWorkspace(page, firstWorkspace.id);
  const crossWorkspaceDetail = await page.evaluate(async (alertId) => {
    const response = await fetch(`/api/alerts/${encodeURIComponent(alertId)}`);
    return { status: response.status, body: await response.json() };
  }, detailAlert.alertId);
  expect(crossWorkspaceDetail).toEqual({ status: 404, body: { error: 'not_found' } });
  const deniedDetailJson = JSON.stringify(crossWorkspaceDetail.body);
  expect(deniedDetailJson).not.toContain(detailAlert.host);
  expect(deniedDetailJson).not.toContain(detailAlert.cveId);
  expect(deniedDetailJson).not.toContain(detailDescription);

  const crossWorkspaceResolve = await page.evaluate(async (alertId) => {
    const response = await fetch(`/api/alerts/${encodeURIComponent(alertId)}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'Cross-workspace attempt' }),
    });
    return { status: response.status, body: await response.json() };
  }, detailAlert.alertId);
  expect(crossWorkspaceResolve).toEqual({ status: 404, body: { error: 'not_found' } });
  const deniedResolveJson = JSON.stringify(crossWorkspaceResolve.body);
  expect(deniedResolveJson).not.toContain(detailAlert.host);
  expect(deniedResolveJson).not.toContain(detailAlert.cveId);

  const anonymousResolve = await request.post(`/api/alerts/${detailAlert.alertId}/resolve`, {
    headers: { 'content-type': 'application/json' },
    data: { note: 'Anonymous attempt' },
  });
  expect(anonymousResolve.status()).toBe(401);

  await page.goto(`/alerts/${detailAlert.alertId}`);
  await expect(page.getByText('Couldn’t load this alert', { exact: true })).toBeVisible();
  await expect(page.getByText(detailAlert.host, { exact: true })).toHaveCount(0);
  await expect(page.getByText(detailAlert.cveId, { exact: true })).toHaveCount(0);
  await expect(page.getByText(detailDescription, { exact: true })).toHaveCount(0);

  await selectWorkspace(page, secondWorkspace.id);
  const alertAfterDetailReads = await prisma.alert.findUniqueOrThrow({
    where: { id: detailAlert.alertId },
  });
  expect(alertAfterDetailReads).toEqual(alertBeforeDetailReads);
  await page.goto('/dashboard');

  const firstSerialized = JSON.stringify(firstData);
  const secondSerialized = JSON.stringify(secondData);
  for (const alert of firstWorkspace.alerts) {
    expect(secondSerialized).not.toContain(alert.host);
    expect(secondSerialized).not.toContain(alert.cveId);
    expect(secondSerialized).not.toContain(alert.alertId);
  }
  for (const alert of secondWorkspace.alerts) {
    expect(firstSerialized).not.toContain(alert.host);
    expect(firstSerialized).not.toContain(alert.cveId);
    expect(firstSerialized).not.toContain(alert.alertId);
  }
  for (const endpoint of overviewEndpoints) {
    expect(firstData[endpoint]?.status).toBe(200);
    expect(secondData[endpoint]?.status).toBe(200);
  }

  const deniedSelection = await page.evaluate(async (workspaceId) => {
    const response = await fetch('/api/workspace/active', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId }),
    });
    return response.status;
  }, inaccessibleWorkspace.id);
  expect(deniedSelection).toBe(403);
  const retainedWorkspace = await page.evaluate(async () => {
    const response = await fetch('/api/workspace/active');
    return response.json();
  });
  expect(retainedWorkspace).toEqual({ workspaceId: secondWorkspace.id });

  const activeWorkspaceButton = page.getByRole('button', {
    name: 'Active workspace: Dashboard workspace second',
  });
  await expect(activeWorkspaceButton).toBeVisible();
  await activeWorkspaceButton.click();
  await expect(
    page.getByRole('menuitemradio', { name: 'Dashboard workspace first' }),
  ).toBeVisible();
  await expect(
    page.getByRole('menuitemradio', { name: 'Dashboard workspace second' }),
  ).toHaveAttribute('aria-checked', 'true');
  await expect(
    page.getByRole('menuitemradio', { name: /Inaccessible dashboard workspace/ }),
  ).toHaveCount(0);
  await page.getByRole('menuitemradio', { name: 'Dashboard workspace first' }).click();

  await expect(
    page.getByRole('button', { name: 'Active workspace: Dashboard workspace first' }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard(?:\/|$)/);
  const switchedSummary = await readDashboardSummary(page);
  expect(switchedSummary.status).toBe(200);
  expect(switchedSummary.body).toMatchObject({
    open: 2,
    ownedByMe: 3,
    snoozed: 1,
    resolvedThisWeek: 1,
  });
  await page.goto(`/alerts?${alertFilters}`);
  await expect(page.getByText('first-open.dashboard.invalid', { exact: true })).toBeVisible();
  await expect(page.getByText('second-critical.dashboard.invalid', { exact: true })).toHaveCount(0);
  const firstAlerts = await readAlertList(page, alertFilters);
  expect(firstAlerts.status).toBe(200);
  expect(firstAlerts.body.items.map((item) => item.asset.host)).toEqual([
    'first-open.dashboard.invalid',
  ]);
  const firstCsv = await readAlertCsv(page, alertFilters);
  expect(firstCsv.status).toBe(200);
  expect(firstCsv.body).toContain('first-open.dashboard.invalid');
  expect(firstCsv.body).not.toContain('second-critical.dashboard.invalid');
  await expect(page.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
  const firstDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const firstDownload = await firstDownloadPromise;
  const firstDownloadPath = await firstDownload.path();
  if (!firstDownloadPath) throw new Error('The first workspace CSV download did not produce a file.');
  const firstDownloadCsv = await readFile(firstDownloadPath, 'utf8');
  expect(firstDownloadCsv).toContain('first-open.dashboard.invalid');
  expect(firstDownloadCsv).not.toContain('second-critical.dashboard.invalid');
  await page.goto('/dashboard');
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Active workspace: Dashboard workspace first' }),
  ).toBeVisible();
  const reloadedWorkspace = await page.evaluate(async () => {
    const response = await fetch('/api/workspace/active');
    return response.json();
  });
  expect(reloadedWorkspace).toEqual({ workspaceId: firstWorkspace.id });
  const reloadedSummary = await readDashboardSummary(page);
  expect(reloadedSummary.status).toBe(200);
  expect(reloadedSummary.body).toMatchObject({
    open: 2,
    ownedByMe: 3,
    snoozed: 1,
    resolvedThisWeek: 1,
  });

  await selectWorkspace(page, emptyWorkspace.id);
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('No open alerts yet.')).toBeVisible();
  await expect(page.getByText('No recurring CVEs in the last 7 days.')).toBeVisible();
  await expect(page.getByText('No remediations yet.')).toBeVisible();

  const emptyData = await readDashboardApis(page);
  expect(emptyData['/api/dashboard/summary']?.body).toMatchObject({
    open: 0,
    ownedByMe: 0,
    snoozed: 0,
    resolvedThisWeek: 0,
  });
  for (const endpoint of overviewEndpoints) {
    expect(emptyData[endpoint]?.status).toBe(200);
  }
  expect(JSON.stringify(emptyData)).not.toContain('first-');
  expect(JSON.stringify(emptyData)).not.toContain('second-');
});

async function createWorkspace(
  ownerUserId: string,
  ownerEmail: string,
  label: string,
): Promise<WorkspaceFixture> {
  const team = await prisma.team.create({
    data: { name: `Dashboard workspace ${label} ${randomUUID()}` },
    select: { id: true },
  });
  fixtureWorkspaceIds.push(team.id);
  await prisma.workspace.create({
    data: { id: team.id, name: `Dashboard workspace ${label}`, ownerUserId },
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
  return { id: team.id, memberId: member.id, alerts: [] };
}

async function createInaccessibleWorkspace(): Promise<{ id: string }> {
  const workspace = await prisma.workspace.create({
    data: { name: `Inaccessible dashboard workspace ${randomUUID()}` },
    select: { id: true },
  });
  fixtureWorkspaceIds.push(workspace.id);
  return workspace;
}

async function createAlert(
  workspace: WorkspaceFixture,
  ownerUserId: string,
  fixture: {
    label: string;
    host: string;
    cveId: string;
    severity: string;
    description?: string;
    createdAt: Date;
    closedAt?: Date;
    remediatedAt?: Date;
    snoozedUntil?: Date;
  },
): Promise<AlertFixture> {
  if (fixture.description) {
    await prisma.cveEntry.create({
      data: {
        cveId: fixture.cveId,
        severity: fixture.severity,
        description: fixture.description,
      },
      select: { cveId: true },
    });
    fixtureCveIds.push(fixture.cveId);
  }

  const scan = await prisma.scan.create({
    data: {
      target: fixture.host,
      status: 'completed',
      teamId: workspace.id,
      startedAt: fixture.createdAt,
    },
    select: { id: true },
  });
  const asset = await prisma.asset.create({
    data: {
      scanId: scan.id,
      host: fixture.host,
      ip: '192.0.2.42',
      port: 443,
      protocol: 'tcp',
      state: 'open',
    },
    select: { id: true },
  });
  const finding = await prisma.vulnerabilityFinding.create({
    data: {
      scanId: scan.id,
      assetId: asset.id,
      cveId: fixture.cveId,
      severity: fixture.severity,
      matchReason: `Synthetic dashboard fixture ${fixture.label}`,
      priorityScore: 75,
      epssScore: 0.42,
      epssPercentile: 0.91,
      kevListed: true,
    },
    select: { id: true },
  });
  const alert = await prisma.alert.create({
    data: {
      teamId: workspace.id,
      findingId: finding.id,
      severity: fixture.severity,
      source: 'kev',
      ownerId: workspace.memberId,
      status: fixture.closedAt ? 'resolved' : 'open',
      createdAt: fixture.createdAt,
      closedAt: fixture.closedAt,
      closedBy: fixture.closedAt ? ownerUserId : null,
      remediatedAt: fixture.remediatedAt,
      remediatedByEmail: fixture.remediatedAt ? email : null,
      snoozedUntil: fixture.snoozedUntil,
    },
    select: { id: true },
  });
  return { alertId: alert.id, host: fixture.host, cveId: fixture.cveId };
}

async function visitWorkspace(page: import('@playwright/test').Page, workspace: WorkspaceFixture) {
  await selectWorkspace(page, workspace.id);
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText(workspace.alerts[0]?.host ?? '')).toBeVisible();
  return readDashboardApis(page);
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

async function readDashboardApis(page: import('@playwright/test').Page) {
  return page.evaluate(async (endpoints) => {
    const responses = await Promise.all(
      endpoints.map(async (endpoint) => {
        const response = await fetch(endpoint);
        return [endpoint, { status: response.status, body: await response.json() }] as const;
      }),
    );
    return Object.fromEntries(responses);
  }, overviewEndpoints);
}

async function readDashboardSummary(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/dashboard/summary');
    return { status: response.status, body: await response.json() };
  });
}

async function readAlertList(
  page: import('@playwright/test').Page,
  search: string,
): Promise<{
  status: number;
  body: { items: Array<{ asset: { host: string | null }; status: string }> };
}> {
  return page.evaluate(async (query) => {
    const response = await fetch(`/api/alerts?${query}`);
    return { status: response.status, body: await response.json() };
  }, search);
}

async function readAlertCsv(
  page: import('@playwright/test').Page,
  search: string,
): Promise<{ status: number; body: string }> {
  return page.evaluate(async (query) => {
    const response = await fetch('/api/alerts/export.csv', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceId: 'vulnaware-alerts',
        filters: Object.fromEntries(new URLSearchParams(query).entries()),
      }),
    });
    const payload = (await response.json()) as { data?: { csv?: string } };
    return { status: response.status, body: payload.data?.csv ?? JSON.stringify(payload) };
  }, search);
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function parseCsvRecords(csv: string): string[][] {
  const text = csv.replace(/^\uFEFF/u, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if (character === '\r' && text[index + 1] === '\n' && !quoted) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      index += 1;
    } else {
      cell += character ?? '';
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
