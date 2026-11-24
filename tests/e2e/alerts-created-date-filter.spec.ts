// @polsia:user-owned — Authenticated /alerts creation-date filter journey.
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { expect, test, type Page } from '@playwright/test';
import { AlertList } from '../../src/lib/contracts/alerts';

const prisma = new PrismaClient();
const email = `alerts-created-date-${randomUUID()}@example.invalid`;
const fixtureWorkspaceIds: string[] = [];
let userId: string | undefined;
let ownedWorkspaceId: string | undefined;

interface WorkspaceFixture {
  id: string;
  memberId?: string;
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

test('date bounds include both calendar days and persist through filters, sorting, pagination, and refresh', async ({
  page,
}) => {
  test.setTimeout(120_000);

  await page.goto('/signup');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic Date Filter Passphrase!23');
  await page.getByLabel('Confirm password').fill('Synthetic Date Filter Passphrase!23');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\/|$)/, { timeout: 30_000 });

  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true, email: true },
  });
  userId = user.id;

  const activeWorkspace = await createWorkspace(user.id, user.email, true);
  const otherWorkspace = await createWorkspace(user.id, user.email, false);
  const host = `created-date-${randomUUID()}.example.invalid`;

  const before = await createAlert(activeWorkspace, host, 1, '2026-10-09T23:59:59.999Z');
  const startBoundary = await createAlert(activeWorkspace, host, 2, '2026-10-10T00:00:00.000Z');
  const endBoundary = await createAlert(activeWorkspace, host, 3, '2026-10-11T23:59:59.999Z');
  const after = await createAlert(activeWorkspace, host, 4, '2026-10-12T00:00:00.000Z');
  await createAlert(activeWorkspace, host, 5, '2026-10-10T12:00:00.000Z', 'low');
  await createAlert(activeWorkspace, host, 6, '2026-10-10T12:00:00.000Z', 'high', 'open');
  const otherWorkspaceAlert = await createAlert(
    otherWorkspace,
    host,
    7,
    '2026-10-10T12:00:00.000Z',
  );
  const storedBoundaries = await prisma.alert.findMany({
    where: { id: { in: [startBoundary.id, endBoundary.id] } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, createdAt: true },
  });
  expect(storedBoundaries).toEqual([
    { id: startBoundary.id, createdAt: new Date('2026-10-10T00:00:00.000Z') },
    { id: endBoundary.id, createdAt: new Date('2026-10-11T23:59:59.999Z') },
  ]);

  await selectWorkspace(page, activeWorkspace.id);
  const initialParams = new URLSearchParams({
    q: 'CVE-2026-71',
    hostname: host,
    status: 'in_progress',
    severity: 'high',
    sort: 'created_asc',
    page: '1',
    pageSize: '1',
  });
  await page.goto(`/alerts?${initialParams.toString()}`);
  await expect(page.getByRole('heading', { name: 'Team alerts' })).toBeVisible();
  await expect(page.getByLabel('From', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('To', { exact: true })).toHaveValue('');

  const unfiltered = await readAlertList(page);
  expect(unfiltered.total).toBe(4);
  expect(unfiltered.items.map((item) => item.id)).toEqual([before.id]);

  await page.getByLabel('From', { exact: true }).fill('2026-10-10');
  await page.getByLabel('To', { exact: true }).fill('2026-10-11');
  await expect
    .poll(() => {
      const params = new URL(page.url()).searchParams;
      return [params.get('from'), params.get('to')];
    })
    .toEqual(['2026-10-10', '2026-10-11']);

  const selectedParams = new URL(page.url()).searchParams;
  expect(selectedParams.get('q')).toBe('CVE-2026-71');
  expect(selectedParams.get('hostname')).toBe(host);
  expect(selectedParams.get('status')).toBe('in_progress');
  expect(selectedParams.get('severity')).toBe('high');
  expect(selectedParams.get('sort')).toBe('created_asc');
  expect(selectedParams.get('page')).toBe('1');
  expect(selectedParams.get('pageSize')).toBe('1');

  let filtered = await readAlertList(page);
  expect(filtered.total, `filtered URL: ${page.url()}`).toBe(2);
  expect(filtered.page).toBe(1);
  expect(filtered.pageSize).toBe(1);
  expect(filtered.items.map((item) => item.id)).toEqual([startBoundary.id]);
  await expect(page.getByText('Page 1 of 2', { exact: true })).toBeVisible();

  const tamperedParams = new URLSearchParams(new URL(page.url()).searchParams);
  tamperedParams.set('workspaceId', otherWorkspace.id);
  tamperedParams.set('teamId', otherWorkspace.id);
  const tampered = await readAlertList(page, tamperedParams.toString());
  expect(tampered.total).toBe(2);
  expect(tampered.items.every((item) => item.teamId === activeWorkspace.id)).toBe(true);
  expect(tampered.items.map((item) => item.id)).not.toContain(otherWorkspaceAlert.id);

  await page.getByRole('button', { name: 'Next page' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe('2');
  filtered = await readAlertList(page);
  expect(filtered.items.map((item) => item.id)).toEqual([endBoundary.id]);
  await page.reload();
  await expect(page.getByLabel('From', { exact: true })).toHaveValue('2026-10-10');
  await expect(page.getByLabel('To', { exact: true })).toHaveValue('2026-10-11');
  await expect.poll(async () => (await readAlertList(page)).items[0]?.id).toBe(endBoundary.id);

  await page.getByRole('combobox', { name: 'Sort alerts' }).click();
  await page.getByRole('option', { name: 'Created (most recent first)' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('sort')).toBe('created');
  const sortedParams = new URL(page.url()).searchParams;
  expect(sortedParams.get('from')).toBe('2026-10-10');
  expect(sortedParams.get('to')).toBe('2026-10-11');
  expect(sortedParams.get('q')).toBe('CVE-2026-71');
  expect(sortedParams.get('hostname')).toBe(host);
  expect(sortedParams.get('status')).toBe('in_progress');
  expect(sortedParams.get('severity')).toBe('high');
  expect(sortedParams.get('page')).toBe('2');
  expect((await readAlertList(page)).items.map((item) => item.id)).toEqual([startBoundary.id]);

  await page.getByRole('button', { name: 'Previous page' }).click();
  await expect.poll(async () => (await readAlertList(page)).items[0]?.id).toBe(endBoundary.id);

  await page.getByLabel('From', { exact: true }).fill('2026-10-12');
  await expect(page.getByText('from must be on or before to')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('from')).toBe('2026-10-10');
  await page.getByLabel('From', { exact: true }).fill('2026-10-10');
  await page.getByLabel('From', { exact: true }).fill('');
  await expect.poll(() => new URL(page.url()).searchParams.has('from')).toBe(false);
  expect((await readAlertList(page)).total).toBe(3);
  expect(new URL(page.url()).searchParams.get('to')).toBe('2026-10-11');
  await page.getByLabel('To', { exact: true }).fill('');
  await expect.poll(() => new URL(page.url()).searchParams.has('to')).toBe(false);
  const cleared = await readAlertList(page);
  expect(cleared.total).toBe(4);
  expect(cleared.items.map((item) => item.id)).toEqual([after.id]);
  expect(new URL(page.url()).searchParams.get('q')).toBe('CVE-2026-71');
  expect(new URL(page.url()).searchParams.get('hostname')).toBe(host);
  expect(new URL(page.url()).searchParams.get('status')).toBe('in_progress');
  expect(new URL(page.url()).searchParams.get('severity')).toBe('high');
  expect(new URL(page.url()).searchParams.get('sort')).toBe('created');

  const malformedParams = new URLSearchParams(initialParams);
  malformedParams.set('from', '2026-02-30');
  malformedParams.set('to', '2026-10-11');
  await page.goto(`/alerts?${malformedParams.toString()}`);
  await expect(page.getByText('Enter a valid start date.')).toBeVisible();
  const malformed = await page.evaluate(async (query) => {
    const response = await fetch(`/api/alerts?${query}`);
    return { status: response.status, body: await response.json() };
  }, malformedParams.toString());
  expect(malformed.status).toBe(400);

  const reversedParams = new URLSearchParams(initialParams);
  reversedParams.set('from', '2026-10-12');
  reversedParams.set('to', '2026-10-11');
  await page.goto(`/alerts?${reversedParams.toString()}`);
  await expect(page.getByText('from must be on or before to')).toBeVisible();
  const reversed = await page.evaluate(async (query) => {
    const response = await fetch(`/api/alerts?${query}`);
    return { status: response.status, body: await response.json() };
  }, reversedParams.toString());
  expect(reversed.status).toBe(400);
  expect(reversed.body).toMatchObject({ error: 'bad_request' });

  await page.goto(`/alerts?${initialParams.toString()}&from=2026-10-10&to=2026-10-11`);
  await expect.poll(async () => (await readAlertList(page)).items[0]?.id).toBe(startBoundary.id);
  await expect(page.getByText('Page 1 of 2', { exact: true })).toBeVisible();

  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await page.getByLabel('From', { exact: true }).scrollIntoViewIfNeeded();
    const dateInputBounds = await page.evaluate(() =>
      ['alerts-date-from', 'alerts-date-to'].map((id) => {
        const element = document.getElementById(id);
        const bounds = element?.getBoundingClientRect();
        return bounds ? { left: bounds.left, right: bounds.right } : null;
      }),
    );
    expect(
      dateInputBounds.every((bounds) => bounds && bounds.left >= 0 && bounds.right <= width),
    ).toBe(true);
    await page.screenshot({ path: `/tmp/polsia-alerts-created-date-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
});

async function createWorkspace(
  ownerUserId: string,
  ownerEmail: string,
  addMember: boolean,
): Promise<WorkspaceFixture> {
  const team = await prisma.team.create({
    data: { name: `Created date filter ${randomUUID()}` },
    select: { id: true },
  });
  fixtureWorkspaceIds.push(team.id);
  await prisma.workspace.create({
    data: {
      id: team.id,
      name: `Created date filter ${randomUUID()}`,
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
  index: number,
  createdAt: string,
  severity = 'high',
  status: 'in_progress' | 'open' = 'in_progress',
): Promise<{ id: string; cveId: string }> {
  const createdAtDate = new Date(createdAt);
  const scan = await prisma.scan.create({
    data: {
      target: host,
      status: 'completed',
      teamId: workspace.id,
      startedAt: createdAtDate,
    },
    select: { id: true },
  });
  const asset = await prisma.asset.create({
    data: {
      scanId: scan.id,
      host,
      ip: `192.0.2.${index}`,
      port: 443,
      protocol: 'tcp',
      state: 'open',
      serviceHint: 'https',
    },
    select: { id: true },
  });
  const cveId = `CVE-2026-71${String(index).padStart(3, '0')}`;
  const finding = await prisma.vulnerabilityFinding.create({
    data: {
      scanId: scan.id,
      assetId: asset.id,
      cveId,
      severity,
      matchReason: 'Synthetic creation-date filter fixture',
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
      severity,
      source: 'kev',
      ownerId: workspace.memberId,
      status,
      createdAt: createdAtDate,
    },
    select: { id: true },
  });
  return { id: alert.id, cveId };
}

async function selectWorkspace(page: Page, workspaceId: string): Promise<void> {
  const response = await page.evaluate(async (id) => {
    const result = await fetch('/api/workspace/active', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: id }),
    });
    return { status: result.status, body: await result.json() };
  }, workspaceId);
  expect(response).toMatchObject({ status: 200, body: { workspaceId } });
}

async function readAlertList(page: Page, search = new URL(page.url()).searchParams.toString()) {
  const response = await page.evaluate(async (query) => {
    const result = await fetch(`/api/alerts?${query}`);
    return { status: result.status, body: await result.json() };
  }, search);
  expect(response.status).toBe(200);
  return AlertList.parse(response.body);
}
