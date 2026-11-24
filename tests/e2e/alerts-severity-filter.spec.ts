// @polsia:user-owned — Authenticated /alerts severity-filter journey.
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { expect, test, type Page } from '@playwright/test';
import { exportResponseSchema } from '../../src/modules/csv-export/contracts';

const prisma = new PrismaClient();
const email = `alerts-severity-${randomUUID()}@example.invalid`;
const fixtureWorkspaceIds: string[] = [];
let userId: string | undefined;
let ownedWorkspaceId: string | undefined;

interface WorkspaceFixture {
  id: string;
  memberId?: string;
}

interface AlertListResponse {
  items: Array<{
    id: string;
    teamId: string;
    cveId: string;
    severity: string | null;
    status: string;
    asset: { host: string };
  }>;
  total: number;
  page: number;
  pageSize: number;
  severityOptions: string[];
}

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
    if (userId) {
      await prisma.workspaceMember.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  } finally {
    await prisma.$disconnect();
  }
});

test('severity filtering and bidirectional sorting preserve workspace, filters, paging, and URL state', async ({
  page,
}) => {
  test.setTimeout(120_000);

  await page.goto('/signup');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic Severity Passphrase!23');
  await page.getByLabel('Confirm password').fill('Synthetic Severity Passphrase!23');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\/|$)/, { timeout: 30_000 });

  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true, email: true },
  });
  userId = user.id;

  const activeWorkspace = await createWorkspace(user.id, user.email, true);
  const inaccessibleWorkspace = await createWorkspace(user.id, user.email, false);
  const host = `severity-target-${randomUUID()}.example.invalid`;
  const otherHost = `severity-other-${randomUUID()}.example.invalid`;

  const firstHigh = await createAlert(activeWorkspace, host, 'high', 'in_progress', 1);
  const low = await createAlert(activeWorkspace, host, 'low', 'in_progress', 2);
  const secondHigh = await createAlert(activeWorkspace, host, 'high', 'in_progress', 3);
  const medium = await createAlert(activeWorkspace, host, 'medium', 'in_progress', 4);
  await createAlert(activeWorkspace, otherHost, 'critical', 'in_progress', 4);
  await createAlert(activeWorkspace, otherHost, 'medium', 'in_progress', 5);
  const privateAlert = await createAlert(
    inaccessibleWorkspace,
    host,
    'high',
    'in_progress',
    6,
  );

  const sortHost = `severity-sort-${randomUUID()}.example.invalid`;
  const sortPrefix = `severity-sort-${randomUUID()}`;
  const sortCritical = await createAlert(activeWorkspace, sortHost, 'critical', 'in_progress', 10, {
    id: `${sortPrefix}-critical`,
    findingSuffix: 'critical',
  });
  const sortHighA = await createAlert(activeWorkspace, sortHost, 'high', 'in_progress', 9, {
    id: `${sortPrefix}-high-a`,
    findingSuffix: 'high-a',
  });
  const sortHighZ = await createAlert(activeWorkspace, sortHost, 'high', 'in_progress', 9, {
    id: `${sortPrefix}-high-z`,
    findingSuffix: 'high-z',
  });
  const sortMedium = await createAlert(activeWorkspace, sortHost, 'medium', 'in_progress', 8, {
    id: `${sortPrefix}-medium`,
    findingSuffix: 'medium',
  });
  const sortLow = await createAlert(activeWorkspace, sortHost, 'low', 'in_progress', 7, {
    id: `${sortPrefix}-low`,
    findingSuffix: 'low',
  });

  await selectWorkspace(page, activeWorkspace.id);
  const initialQuery = new URLSearchParams({
    status: 'in_progress',
    hostname: host,
    sort: 'created_asc',
    page: '2',
    pageSize: '1',
  });
  await page.goto(`/alerts?${initialQuery.toString()}`);
  await expect(page.getByRole('heading', { name: 'Team alerts' })).toBeVisible();

  const severityControls = page.locator('fieldset[aria-label="Filter alerts by severity"]');
  for (const severity of ['Critical', 'High', 'Medium', 'Low']) {
    await expect(
      severityControls.getByRole('button', { name: severity, exact: true }),
    ).toBeVisible();
  }
  await expect(severityControls.getByRole('button', { name: 'Extreme', exact: true })).toHaveCount(
    0,
  );

  const initialList = await readAlertList(page);
  expect(initialList.total).toBe(4);
  expect(initialList.page).toBe(2);
  expect(initialList.pageSize).toBe(1);
  expect(initialList.items.map((item) => item.cveId)).toEqual([low.cveId]);
  expect(initialList.severityOptions).toEqual(['critical', 'high', 'medium', 'low']);

  await severityControls.getByRole('button', { name: 'High', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('severity')).toBe('high');
  await expect.poll(async () => (await readAlertList(page)).items[0]?.cveId).toBe(secondHigh.cveId);
  const selectedParams = new URL(page.url()).searchParams;
  expect(selectedParams.get('status')).toBe('in_progress');
  expect(selectedParams.get('hostname')).toBe(host);
  expect(selectedParams.get('sort')).toBe('created_asc');
  expect(selectedParams.get('page')).toBe('2');
  expect(selectedParams.get('pageSize')).toBe('1');
  await expect(severityControls.getByRole('button', { name: 'High', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  const fullHighParams = new URLSearchParams(new URL(page.url()).searchParams);
  fullHighParams.set('page', '1');
  fullHighParams.set('pageSize', '50');
  const fullHighList = await readAlertList(page, fullHighParams.toString());
  expect(fullHighList.items.map((item) => item.cveId)).toEqual([firstHigh.cveId, secondHigh.cveId]);
  const highExport = await exportCurrentAlerts(page);
  expect(highExport.cveIds).toEqual(fullHighList.items.map((item) => item.cveId));
  expect(highExport.cveIds).not.toContain(privateAlert.cveId);
  expect(highExport.rows.every((row) => row.severity === 'high')).toBe(true);

  await page.reload();
  await expect(severityControls.getByRole('button', { name: 'High', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect.poll(async () => (await readAlertList(page)).items[0]?.cveId).toBe(secondHigh.cveId);

  await severityControls.getByRole('button', { name: 'Medium', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('severity')).toBe('high,medium');
  const fullMultiSeverityParams = new URLSearchParams(new URL(page.url()).searchParams);
  fullMultiSeverityParams.set('page', '1');
  fullMultiSeverityParams.set('pageSize', '50');
  const fullMultiSeverityList = await readAlertList(page, fullMultiSeverityParams.toString());
  expect(fullMultiSeverityList.items.map((item) => item.cveId)).toEqual([
    firstHigh.cveId,
    secondHigh.cveId,
    medium.cveId,
  ]);
  const multiSeverityExport = await exportCurrentAlerts(page);
  expect(multiSeverityExport.cveIds).toEqual(
    fullMultiSeverityList.items.map((item) => item.cveId),
  );
  expect(
    multiSeverityExport.rows.every((row) => ['high', 'medium'].includes(row.severity ?? '')),
  ).toBe(true);

  await severityControls.getByRole('button', { name: 'High', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('severity')).toBe('medium');
  await severityControls.getByRole('button', { name: 'Medium', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.has('severity')).toBe(false);
  const fullUnfilteredParams = new URLSearchParams(new URL(page.url()).searchParams);
  fullUnfilteredParams.set('page', '1');
  fullUnfilteredParams.set('pageSize', '50');
  const fullUnfilteredList = await readAlertList(page, fullUnfilteredParams.toString());
  expect(fullUnfilteredList.items.map((item) => item.cveId)).toEqual([
    firstHigh.cveId,
    low.cveId,
    secondHigh.cveId,
    medium.cveId,
  ]);
  const deselectedExport = await exportCurrentAlerts(page);
  expect(deselectedExport.cveIds).toEqual(fullUnfilteredList.items.map((item) => item.cveId));
  expect(deselectedExport.cveIds).not.toContain(privateAlert.cveId);

  await severityControls.getByRole('button', { name: 'Critical', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('severity')).toBe('critical');
  await expect(
    page.getByRole('cell', { name: 'No alerts match the current filters.' }),
  ).toBeVisible();
  const noMatches = await readAlertList(page);
  expect(noMatches.total).toBe(0);
  expect(noMatches.items).toEqual([]);

  await severityControls.getByRole('button', { name: 'All', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.has('severity')).toBe(false);
  await expect.poll(async () => (await readAlertList(page)).items[0]?.cveId).toBe(low.cveId);
  const clearedParams = new URL(page.url()).searchParams;
  expect(clearedParams.get('status')).toBe('in_progress');
  expect(clearedParams.get('hostname')).toBe(host);
  expect(clearedParams.get('sort')).toBe('created_asc');
  expect(clearedParams.get('page')).toBe('2');
  expect(clearedParams.get('pageSize')).toBe('1');
  const allButtonExport = await exportCurrentAlerts(page);
  expect(allButtonExport.cveIds).toEqual(fullUnfilteredList.items.map((item) => item.cveId));
  expect(allButtonExport.cveIds).not.toContain(privateAlert.cveId);

  const forgedWorkspaceExport = await page.evaluate(async (workspaceId) => {
    const response = await fetch('/api/alerts/export.csv', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceId: 'vulnaware-alerts',
        filters: { status: 'in_progress', workspaceId },
      }),
    });
    return { status: response.status, body: await response.json() };
  }, inaccessibleWorkspace.id);
  expect(forgedWorkspaceExport).toMatchObject({
    status: 400,
    body: { ok: false, error: { code: 'INVALID_FILTERS' } },
  });

  const sortParams = new URLSearchParams({
    q: 'severity-sort',
    status: 'in_progress',
    hostname: sortHost,
    sort: 'severity',
    page: '2',
    pageSize: '2',
  });
  await page.goto(`/alerts?${sortParams.toString()}`);
  const sortControl = page.getByRole('combobox', { name: 'Sort alerts' });
  await expect(sortControl).toContainText('Severity (critical to low)');

  const descendingSecondPage = await readAlertList(page);
  expect(descendingSecondPage.total).toBe(5);
  expect(descendingSecondPage.page).toBe(2);
  expect(descendingSecondPage.pageSize).toBe(2);
  expect(descendingSecondPage.items.map((item) => item.id)).toEqual([sortHighA.id, sortMedium.id]);

  const descendingFirstPageParams = new URLSearchParams(sortParams);
  descendingFirstPageParams.set('page', '1');
  const descendingFirstPage = await readAlertList(page, descendingFirstPageParams.toString());
  expect(descendingFirstPage.items.map((item) => item.id)).toEqual([sortCritical.id, sortHighZ.id]);

  const descendingThirdPageParams = new URLSearchParams(sortParams);
  descendingThirdPageParams.set('page', '3');
  const descendingThirdPage = await readAlertList(page, descendingThirdPageParams.toString());
  expect(descendingThirdPage.items.map((item) => item.id)).toEqual([sortLow.id]);

  await sortControl.click();
  await page.getByRole('option', { name: 'Severity (low to critical)' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('sort')).toBe('severity_asc');
  const ascendingParams = new URL(page.url()).searchParams;
  expect(ascendingParams.get('q')).toBe('severity-sort');
  expect(ascendingParams.get('status')).toBe('in_progress');
  expect(ascendingParams.get('hostname')).toBe(sortHost);
  expect(ascendingParams.get('page')).toBe('2');
  expect(ascendingParams.get('pageSize')).toBe('2');

  const ascendingSecondPage = await readAlertList(page);
  expect(ascendingSecondPage.total).toBe(5);
  expect(ascendingSecondPage.page).toBe(2);
  expect(ascendingSecondPage.pageSize).toBe(2);
  expect(ascendingSecondPage.items.map((item) => item.id)).toEqual([sortHighA.id, sortHighZ.id]);

  const ascendingFirstPageParams = new URLSearchParams(ascendingParams);
  ascendingFirstPageParams.set('page', '1');
  const ascendingFirstPage = await readAlertList(page, ascendingFirstPageParams.toString());
  expect(ascendingFirstPage.items.map((item) => item.id)).toEqual([sortLow.id, sortMedium.id]);

  const ascendingThirdPageParams = new URLSearchParams(ascendingParams);
  ascendingThirdPageParams.set('page', '3');
  const ascendingThirdPage = await readAlertList(page, ascendingThirdPageParams.toString());
  expect(ascendingThirdPage.items.map((item) => item.id)).toEqual([sortCritical.id]);

  await page.reload();
  await expect(sortControl).toContainText('Severity (low to critical)');
  await expect
    .poll(async () => (await readAlertList(page)).items.map((item) => item.id))
    .toEqual([sortHighA.id, sortHighZ.id]);

  await sortControl.click();
  await page.getByRole('option', { name: 'Severity (critical to low)' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('sort')).toBe('severity');
  const refreshedDescendingSecondPage = await readAlertList(page);
  expect(refreshedDescendingSecondPage.items.map((item) => item.id)).toEqual([
    sortHighA.id,
    sortMedium.id,
  ]);
  const refreshedDescendingFirstPageParams = new URLSearchParams(new URL(page.url()).searchParams);
  refreshedDescendingFirstPageParams.set('page', '1');
  const refreshedDescendingFirstPage = await readAlertList(
    page,
    refreshedDescendingFirstPageParams.toString(),
  );
  expect(refreshedDescendingFirstPage.items.map((item) => item.id)).toEqual([
    sortCritical.id,
    sortHighZ.id,
  ]);

  const tamperedWorkspaceList = await readAlertList(
    page,
    new URLSearchParams({
      teamId: inaccessibleWorkspace.id,
      workspaceId: inaccessibleWorkspace.id,
      status: 'in_progress',
      hostname: host,
      severity: 'high',
      sort: 'created_asc',
      page: '1',
      pageSize: '10',
    }).toString(),
  );
  expect(tamperedWorkspaceList.total).toBe(2);
  expect(tamperedWorkspaceList.items.every((item) => item.asset.host === host)).toBe(true);
  expect(tamperedWorkspaceList.severityOptions).toEqual(['critical', 'high', 'medium', 'low']);
  expect(tamperedWorkspaceList.items.map((item) => item.cveId)).toEqual([
    firstHigh.cveId,
    secondHigh.cveId,
  ]);

  const scopedSeverityParams = new URLSearchParams({
    status: 'in_progress',
    sort: 'severity',
    page: '1',
    pageSize: '50',
  });
  const activeWorkspaceSeverity = await readAlertList(page, scopedSeverityParams.toString());
  scopedSeverityParams.set('teamId', inaccessibleWorkspace.id);
  scopedSeverityParams.set('workspaceId', inaccessibleWorkspace.id);
  const tamperedSeverityList = await readAlertList(page, scopedSeverityParams.toString());
  expect(tamperedSeverityList.total).toBe(activeWorkspaceSeverity.total);
  expect(tamperedSeverityList.items.map((item) => item.id)).toEqual(
    activeWorkspaceSeverity.items.map((item) => item.id),
  );
  expect(tamperedSeverityList.items.every((item) => item.teamId === activeWorkspace.id)).toBe(true);
  expect(tamperedSeverityList.items.map((item) => item.id)).not.toContain(privateAlert.id);

  for (const viewport of [
    { width: 320, height: 800, file: '/tmp/polsia-alerts-severity-320.png' },
    { width: 390, height: 844, file: '/tmp/polsia-alerts-severity-390.png' },
    { width: 1440, height: 900, file: '/tmp/polsia-alerts-severity-desktop.png' },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await severityControls.scrollIntoViewIfNeeded();
    await sortControl.scrollIntoViewIfNeeded();
    await page.screenshot({ path: viewport.file, fullPage: true });
    const sortBounds = await sortControl.boundingBox();
    const sortLayout = await sortControl.evaluate((control) => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      control: control.getBoundingClientRect().toJSON(),
      parent: control.parentElement?.getBoundingClientRect().toJSON(),
      parentClass: control.parentElement?.className,
    }));
    expect(sortBounds, `sort control visible at ${viewport.width}px`).not.toBeNull();
    expect(sortBounds?.x).toBeGreaterThanOrEqual(0);
    expect(
      sortBounds?.x + (sortBounds?.width ?? 0),
      `sort control layout: ${JSON.stringify(sortLayout)}`,
    ).toBeLessThanOrEqual(viewport.width);
    const clippedSeverityButtons = await severityControls.evaluate((fieldset) =>
      Array.from(fieldset.querySelectorAll('button'))
        .map((button) => {
          const bounds = button.getBoundingClientRect();
          return {
            label: button.textContent?.trim() ?? '',
            left: bounds.left,
            right: bounds.right,
          };
        })
        .filter((bounds) => bounds.left < 0 || bounds.right > window.innerWidth),
    );
    expect(clippedSeverityButtons, `clipped at ${viewport.width}px`).toEqual([]);
  }
});

async function createWorkspace(
  ownerUserId: string,
  ownerEmail: string,
  addMember: boolean,
): Promise<WorkspaceFixture> {
  const team = await prisma.team.create({
    data: { name: `Alerts severity ${randomUUID()}` },
    select: { id: true },
  });
  fixtureWorkspaceIds.push(team.id);
  await prisma.workspace.create({
    data: {
      id: team.id,
      name: `Alerts severity ${randomUUID()}`,
      ownerUserId: addMember ? ownerUserId : null,
    },
  });
  if (!addMember) return { id: team.id };

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

async function createAlert(
  workspace: WorkspaceFixture,
  host: string,
  severity: string,
  status: 'in_progress',
  createdDay: number,
  options: { id?: string; findingSuffix?: string } = {},
): Promise<{ id: string; cveId: string }> {
  const scan = await prisma.scan.create({
    data: {
      target: host,
      status: 'completed',
      teamId: workspace.id,
      startedAt: new Date(`2026-10-${String(createdDay).padStart(2, '0')}T12:00:00.000Z`),
    },
    select: { id: true },
  });
  const asset = await prisma.asset.create({
    data: {
      scanId: scan.id,
      host,
      ip: `192.0.2.${createdDay}`,
      port: 443,
      protocol: 'tcp',
      state: 'open',
      serviceHint: 'https',
    },
    select: { id: true },
  });
  const cveId = `CVE-2026-${String(90000 + createdDay).padStart(5, '0')}-${options.findingSuffix ?? randomUUID().slice(0, 8)}`;
  const finding = await prisma.vulnerabilityFinding.create({
    data: {
      scanId: scan.id,
      assetId: asset.id,
      cveId,
      severity,
      matchReason: 'Synthetic severity filter fixture',
      priorityScore: 75,
      epssScore: 0.42,
      epssPercentile: 0.91,
      kevListed: true,
    },
    select: { id: true },
  });
  const alert = await prisma.alert.create({
    data: {
      ...(options.id ? { id: options.id } : {}),
      teamId: workspace.id,
      findingId: finding.id,
      severity,
      source: 'kev',
      ownerId: workspace.memberId,
      status,
      createdAt: new Date(`2026-10-${String(createdDay).padStart(2, '0')}T12:00:00.000Z`),
    },
    select: { id: true },
  });
  return { id: alert.id, cveId };
}

async function selectWorkspace(page: Page, workspaceId: string) {
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

async function readAlertList(page: Page, query?: string): Promise<AlertListResponse> {
  return page.evaluate(async (search) => {
    const params = search ?? window.location.search.slice(1);
    const response = await fetch(`/api/alerts${params ? `?${params}` : ''}`);
    if (!response.ok) throw new Error(`GET /api/alerts returned ${response.status}`);
    return response.json();
  }, query);
}

interface ExportedAlertRow {
  cveId: string | null;
  assetHost: string | null;
  severity: string | null;
  status: string | null;
}

async function exportCurrentAlerts(
  page: Page,
): Promise<{ cveIds: string[]; rows: ExportedAlertRow[] }> {
  const [response, download] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname === '/api/alerts/export.csv' &&
        candidate.request().method() === 'POST',
    ),
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export CSV' }).click(),
  ]).then(([candidate, file]) => [candidate, file] as const);
  expect(response.status()).toBe(200);
  const result = exportResponseSchema.parse(await response.json());
  expect(download.suggestedFilename()).toBe(result.data.filename);

  const lines = result.data.csv.replace(/^\uFEFF/u, '').trimEnd().split('\r\n');
  const header = parseCsvRecord(lines[0] ?? '');
  const columnIndexes = {
    assetHost: header.indexOf('asset_host'),
    cveId: header.indexOf('cve_id'),
    severity: header.indexOf('severity'),
    status: header.indexOf('status'),
  };
  expect(Object.values(columnIndexes).every((index) => index >= 0)).toBe(true);
  const rows = lines.slice(1).map((line): ExportedAlertRow => {
    const cells = parseCsvRecord(line);
    return {
      assetHost: decodeCsvCell(cells[columnIndexes.assetHost]),
      cveId: decodeCsvCell(cells[columnIndexes.cveId]),
      severity: decodeCsvCell(cells[columnIndexes.severity]),
      status: decodeCsvCell(cells[columnIndexes.status]),
    };
  });
  expect(rows).toHaveLength(result.data.records);
  return { cveIds: rows.flatMap((row) => (row.cveId ? [row.cveId] : [])), rows };
}

function parseCsvRecord(line: string): string[] {
  return Array.from(line.matchAll(/"((?:[^"]|"")*)"/gu), (match) =>
    (match[1] ?? '').replaceAll('""', '"'),
  );
}

function decodeCsvCell(cell: string | undefined): string | null {
  if (cell === undefined || cell === '\\N') return null;
  if (!cell.startsWith("'")) throw new Error('CSV export text protection prefix is missing.');
  return cell.slice(1);
}
