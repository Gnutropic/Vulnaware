// @polsia:user-owned — Focused scope and status coverage for the alert CSV adapter.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CSV_EXPORT_LIMITS } from '@/modules/csv-export/contracts';
import { decodeCell } from '@/modules/csv-export/serialization';

vi.mock('server-only', () => ({}));

const alertFindMany = vi.fn();
const transactionWorkspaceMemberFindFirst = vi.fn();
const transactionAlertNoteGroupBy = vi.fn();
const transactionCveEntryFindMany = vi.fn();
const transactionClient = {
  $executeRaw: vi.fn(),
  workspaceMember: { findFirst: transactionWorkspaceMemberFindFirst },
  alert: { findMany: alertFindMany },
  alertNote: { groupBy: transactionAlertNoteGroupBy },
  cveEntry: { findMany: transactionCveEntryFindMany },
};
const prismaTransaction = vi.fn(
  async (callback: (tx: typeof transactionClient) => Promise<unknown>) => callback(transactionClient),
);
const workspaceMemberFindFirst = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    $transaction: prismaTransaction,
    workspaceMember: { findFirst: workspaceMemberFindFirst },
  },
}));

const authGetSession = vi.fn();
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: authGetSession } } }));

const resolveDashboardWorkspaceContext = vi.fn();
vi.mock('@/lib/business/dashboard-workspace-context', () => ({
  resolveDashboardWorkspaceContext,
}));

import { buildAlertsExportFilters } from '@/lib/business/alerts-export-filters';

const ACTIVE_WORKSPACE_ID = 'active-workspace-1';
const FOREIGN_WORKSPACE_ID = 'foreign-workspace';

function makeAlert(
  status: 'open' | 'in_progress' | 'resolved' | 'false_positive',
  snoozedUntil: Date | null,
  id = 'alert-active-1',
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    teamId: ACTIVE_WORKSPACE_ID,
    severity: 'high',
    status,
    source: 'manual',
    createdAt: new Date('2026-10-30T12:00:00.000Z'),
    acknowledgedAt: null,
    assigneeId: null,
    ownerId: 'active-member-1',
    remediatedAt: null,
    snoozedUntil,
    finding: {
      cveId: 'CVE-2026-90001',
      priorityScore: 90,
      asset: { host: 'api.example.test' },
    },
    ...overrides,
  };
}

function parseCsvRecords(csv: string): string[][] {
  const input = csv.startsWith('\uFEFF') ? csv.slice(1) : csv;
  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === '"') {
      if (quoted && input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && character === ',') {
      row.push(cell);
      cell = '';
    } else if (!quoted && character === '\n') {
      row.push(cell.replace(/\r$/, ''));
      records.push(row);
      row = [];
      cell = '';
    } else {
      cell += character ?? '';
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell.replace(/\r$/, ''));
    records.push(row);
  }
  return records;
}

function parseExportedAlerts(csv: string): Array<{ id: string; status: string }> {
  const records = parseCsvRecords(csv);
  const headers = records[0] ?? [];
  const keyIndex = headers.indexOf('__polsia_key');
  const statusIndex = headers.indexOf('status');
  if (keyIndex < 0 || statusIndex < 0) return [];

  return records.slice(1).flatMap((record) => {
    const key = decodeCell(record[keyIndex] ?? '');
    const status = decodeCell(record[statusIndex] ?? '');
    const separator = key?.indexOf(':') ?? -1;
    if (separator < 0 || status === null) return [];
    return [{ id: key.slice(separator + 1), status }];
  });
}

async function exportAlerts(filters: unknown) {
  const { csvExportSources } = await import('@/lib/csv-export/sources.server');
  const source = csvExportSources.find((candidate) => candidate.id === 'vulnaware-alerts');
  if (!source) throw new Error('Workspace alerts CSV source is not registered.');
  return source.export(
    { filters },
    { actorId: 'active-user-1', scopeId: ACTIVE_WORKSPACE_ID },
  );
}

beforeEach(() => {
  alertFindMany.mockReset();
  transactionWorkspaceMemberFindFirst.mockReset();
  transactionAlertNoteGroupBy.mockReset();
  transactionCveEntryFindMany.mockReset();
  transactionClient.$executeRaw.mockReset();
  transactionWorkspaceMemberFindFirst.mockResolvedValue({ id: 'active-member-1' });
  transactionAlertNoteGroupBy.mockResolvedValue([]);
  transactionCveEntryFindMany.mockResolvedValue([
    { cveId: 'CVE-2026-90001', description: 'Example vulnerability' },
  ]);
  prismaTransaction.mockReset();
  prismaTransaction.mockImplementation(async (callback) => callback(transactionClient));
  workspaceMemberFindFirst.mockReset();
  workspaceMemberFindFirst.mockResolvedValue({ role: 'admin' });
  authGetSession.mockReset();
  authGetSession.mockResolvedValue({ user: { id: 'active-user-1' } });
  resolveDashboardWorkspaceContext.mockReset();
  resolveDashboardWorkspaceContext.mockResolvedValue({
    workspaceId: ACTIVE_WORKSPACE_ID,
    workspaceMemberId: 'active-member-1',
  });
});

describe('workspace alerts CSV adapter', () => {
  it('exports each persisted workflow status and keeps snooze as a separate condition', async () => {
    const futureSnooze = new Date(Date.now() + 60_000);
    const alerts = [
      makeAlert('open', null, 'status-open'),
      makeAlert('in_progress', null, 'status-in-progress'),
      makeAlert('resolved', null, 'status-resolved'),
      makeAlert('false_positive', null, 'status-false-positive'),
      makeAlert('open', futureSnooze, 'status-snoozed-open'),
    ];
    alertFindMany.mockResolvedValueOnce(alerts);

    const result = await exportAlerts({ resolution: 'all' });
    const records = parseCsvRecords(result.csv);
    expect(records[0]).toEqual([
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
    expect(
      new Map(parseExportedAlerts(result.csv).map((row) => [row.id, row.status])),
    ).toEqual(
      new Map([
        ['status-open', 'open'],
        ['status-in-progress', 'in_progress'],
        ['status-resolved', 'resolved'],
        ['status-false-positive', 'false_positive'],
        ['status-snoozed-open', 'open'],
      ]),
    );
  });

  it.each([
    {
      name: 'resolution',
      filters: { resolution: 'resolved' },
      status: 'resolved' as const,
      expectedWhere: { status: 'resolved' },
    },
    {
      name: 'severity',
      filters: { severity: 'high' },
      status: 'open' as const,
      expectedWhere: { severity: { in: ['high'] } },
    },
    {
      name: 'source',
      filters: { source: 'manual' },
      status: 'open' as const,
      expectedWhere: { source: 'manual' },
    },
    {
      name: 'triggeredBy',
      filters: { triggeredBy: 'scheduled' },
      status: 'open' as const,
      expectedWhere: { finding: { scan: { source: 'scheduled' } } },
    },
    {
      name: 'status',
      filters: { status: 'in_progress' },
      status: 'in_progress' as const,
      expectedWhere: { status: 'in_progress' },
    },
    {
      name: 'acknowledged=true',
      filters: { acknowledged: 'true' },
      status: 'open' as const,
      expectedWhere: { acknowledgedAt: { not: null } },
    },
    {
      name: 'acknowledged=false',
      filters: { acknowledged: 'false' },
      status: 'open' as const,
      expectedWhere: { acknowledgedAt: null },
    },
    {
      name: 'assigneeReady=true',
      filters: { assigneeReady: 'true' },
      status: 'open' as const,
      expectedWhere: { acknowledgedAt: null, assigneeId: null },
    },
    {
      name: 'assigneeReady=false',
      filters: { assigneeReady: 'false' },
      status: 'open' as const,
      expectedWhere: {
        OR: expect.arrayContaining([
          { acknowledgedAt: { not: null } },
          { assigneeId: { not: null } },
        ]),
      },
    },
    {
      name: 'hideSnoozed',
      filters: { hideSnoozed: '1' },
      status: 'open' as const,
      expectedWhere: {
        OR: expect.arrayContaining([
          { snoozedUntil: null },
          { snoozedUntil: { lte: expect.any(Date) } },
        ]),
      },
    },
    {
      name: 'highRiskAssets',
      filters: { highRiskAssets: '1' },
      status: 'open' as const,
      expectedWhere: { finding: { priorityScore: { gte: expect.any(Number) } } },
    },
    {
      name: 'q',
      filters: { q: 'legacy' },
      status: 'open' as const,
      expectedWhere: {
        finding: { OR: expect.arrayContaining([{ cveId: { contains: 'legacy', mode: 'insensitive' } }]) },
      },
    },
    {
      name: 'hostname',
      filters: { hostname: 'api.example' },
      status: 'open' as const,
      expectedWhere: {
        finding: { asset: { host: { contains: 'api.example', mode: 'insensitive' } } },
      },
    },
    {
      name: 'asset',
      filters: { asset: 'api.example.test:443/tcp' },
      status: 'open' as const,
      expectedWhere: {
        finding: { asset: { OR: [{ host: 'api.example.test', port: 443, protocol: 'tcp' }] } },
      },
    },
    {
      name: 'from',
      filters: { from: '2026-10-01' },
      status: 'open' as const,
      expectedWhere: { createdAt: { gte: expect.any(Date) } },
    },
    {
      name: 'to',
      filters: { to: '2026-10-31' },
      status: 'open' as const,
      expectedWhere: { createdAt: { lt: expect.any(Date) } },
    },
    {
      name: 'since',
      filters: { since: '7d' },
      status: 'open' as const,
      expectedWhere: {
        OR: expect.arrayContaining([
          expect.objectContaining({ createdAt: { gte: expect.any(Date) } }),
          expect.objectContaining({ statusChangedAt: { gte: expect.any(Date) } }),
        ]),
      },
    },
    {
      name: 'ownedByMe',
      filters: { ownedByMe: '1' },
      status: 'open' as const,
      expectedWhere: { ownerId: { in: ['active-member-1'] } },
    },
    {
      name: 'remediated',
      filters: { remediated: '1' },
      status: 'open' as const,
      expectedWhere: { remediatedAt: { not: null } },
    },
    {
      name: 'snoozed',
      filters: { snoozed: '1' },
      status: 'open' as const,
      expectedWhere: { snoozedUntil: { gt: expect.any(Date) } },
    },
  ])('applies the $name filter and exports its matching alert', async (testCase) => {
    const id = `family-${testCase.name.replaceAll(/[^a-z0-9]+/giu, '-')}`;
    const snooze = testCase.name === 'snoozed' ? new Date(Date.now() + 60_000) : null;
    alertFindMany.mockResolvedValueOnce([makeAlert(testCase.status, snooze, id)]);

    const result = await exportAlerts(testCase.filters);
    expect(parseExportedAlerts(result.csv).map((row) => row.id)).toEqual([id]);
    const query = alertFindMany.mock.calls[0]?.[0] as
      | { where?: Record<string, unknown> }
      | undefined;
    expect(query?.where).toMatchObject({ teamId: ACTIVE_WORKSPACE_ID, ...testCase.expectedWhere });
  });

  it('composes active filters and exports the full matching result in selected order', async () => {
    const alerts = [
      makeAlert('in_progress', null, 'combined-critical', {
        severity: 'critical',
        createdAt: new Date('2026-10-30T12:00:00.000Z'),
      }),
      makeAlert('in_progress', null, 'combined-high-new', {
        severity: 'high',
        createdAt: new Date('2026-10-29T12:00:00.000Z'),
      }),
      makeAlert('in_progress', null, 'combined-high-old', {
        severity: 'high',
        createdAt: new Date('2026-10-28T12:00:00.000Z'),
      }),
    ];
    alertFindMany.mockResolvedValueOnce(alerts);

    const result = await exportAlerts({
      resolution: 'unresolved',
      severity: 'critical,high',
      source: 'manual',
      triggeredBy: 'scheduled',
      status: 'in_progress',
      acknowledged: 'true',
      assigneeReady: 'false',
      highRiskAssets: '1',
      q: 'legacy',
      hostname: 'api.example',
      asset: 'api.example.test:443/tcp',
      from: '2026-10-01',
      to: '2026-10-31',
      since: '30d',
      sort: 'severity_asc',
      ownedByMe: '1',
      remediated: '1',
    });

    expect(parseExportedAlerts(result.csv).map((row) => row.id)).toEqual([
      'combined-high-old',
      'combined-high-new',
      'combined-critical',
    ]);
    const query = alertFindMany.mock.calls[0]?.[0] as
      | { where?: Record<string, unknown>; orderBy?: unknown; take?: number; skip?: number }
      | undefined;
    expect(query?.where).toMatchObject({
      teamId: ACTIVE_WORKSPACE_ID,
      source: 'manual',
      status: 'in_progress',
      severity: { in: ['critical', 'high'] },
      acknowledgedAt: { not: null },
      ownerId: { in: ['active-member-1'] },
      remediatedAt: { not: null },
      finding: {
        scan: { source: 'scheduled' },
        priorityScore: { gte: expect.any(Number) },
        OR: expect.arrayContaining([{ cveId: { contains: 'legacy', mode: 'insensitive' } }]),
        asset: {
          host: { contains: 'api.example', mode: 'insensitive' },
          OR: [{ host: 'api.example.test', port: 443, protocol: 'tcp' }],
        },
      },
    });
    expect(query?.take).toBe(CSV_EXPORT_LIMITS.records + 1);
    expect(query).not.toHaveProperty('skip');
  });

  it('exports matching alerts beyond the visible page and rejects a result over the module limit', async () => {
    const visiblePageBoundaryRows = Array.from({ length: 55 }, (_, index) =>
      makeAlert('open', null, `page-row-${String(index).padStart(2, '0')}`, {
        createdAt: new Date(Date.UTC(2026, 9, 30, 0, 0, 55 - index)),
      }),
    );
    alertFindMany.mockResolvedValueOnce(visiblePageBoundaryRows);
    const result = await exportAlerts({ resolution: 'all' });
    expect(result.records).toBe(55);
    expect(parseExportedAlerts(result.csv)).toHaveLength(55);
    expect(parseExportedAlerts(result.csv).map((row) => row.id)).toContain('page-row-54');

    const overLimitRows = Array.from({ length: CSV_EXPORT_LIMITS.records + 1 }, (_, index) =>
      makeAlert('open', null, `over-limit-${String(index).padStart(5, '0')}`),
    );
    alertFindMany.mockResolvedValueOnce(overLimitRows);
    await expect(exportAlerts({ resolution: 'all' })).rejects.toMatchObject({
      code: 'ROW_LIMIT',
    });
  });

  it('exports only active-workspace rows when the URL carries a forged workspaceId', async () => {
    const activeAlert = makeAlert('open', null, 'active-workspace-alert', {
      teamId: ACTIVE_WORKSPACE_ID,
    });
    const foreignAlert = makeAlert('resolved', null, 'foreign-workspace-alert', {
      teamId: FOREIGN_WORKSPACE_ID,
    });
    alertFindMany.mockImplementationOnce(
      async (args: { where: { teamId: string } }) =>
        [activeAlert, foreignAlert].filter((alert) => alert.teamId === args.where.teamId),
    );

    const request = new Request(
      `https://app.example.test/api/alerts/export.csv?workspaceId=${FOREIGN_WORKSPACE_ID}`,
    );
    const { authorizeCsvExport } = await import('@/lib/csv-export/sources.server');
    const context = await authorizeCsvExport(request, 'vulnaware-alerts');
    const result = await exportAlerts(buildAlertsExportFilters(new URL(request.url).search));

    expect(context.scopeId).toBe(ACTIVE_WORKSPACE_ID);
    expect(parseExportedAlerts(result.csv)).toEqual([
      { id: 'active-workspace-alert', status: 'open' },
    ]);
    expect(result.csv).not.toContain('foreign-workspace-alert');
    expect(alertFindMany.mock.calls[0]?.[0]?.where).toMatchObject({
      teamId: ACTIVE_WORKSPACE_ID,
    });
  });

  it.each(['no active workspace', 'inactive membership'] as const)(
    'denies export with %s',
    async (failure) => {
      const request = new Request('https://app.example.test/api/alerts/export.csv');
      const { authorizeCsvExport } = await import('@/lib/csv-export/sources.server');
      if (failure === 'no active workspace') {
        resolveDashboardWorkspaceContext.mockResolvedValueOnce(null);
      } else {
        workspaceMemberFindFirst.mockResolvedValueOnce(null);
      }

      await expect(authorizeCsvExport(request, 'vulnaware-alerts')).rejects.toMatchObject({
        status: 403,
      });
      expect(alertFindMany).not.toHaveBeenCalled();
    },
  );

  it.each(['open', 'in_progress', 'resolved', 'false_positive', 'snoozed'] as const)(
    'exports status=%s with other filters in the active workspace despite a forged workspaceId',
    async (status) => {
      const futureSnooze = new Date(Date.now() + 60_000);
      const searchParams = new URLSearchParams({
        status,
        severity: 'high',
        source: 'manual',
        workspaceId: FOREIGN_WORKSPACE_ID,
      });
      if (status === 'open') {
        searchParams.set('hideSnoozed', '1');
        searchParams.set('since', '7d');
      }
      alertFindMany.mockResolvedValueOnce([
        makeAlert(
          status === 'snoozed' ? 'open' : status,
          status === 'snoozed' ? futureSnooze : null,
        ),
      ]);

      const request = new Request(
        `https://app.example.test/api/alerts/export.csv?${searchParams.toString()}`,
      );
      const { authorizeCsvExport, csvExportSources } = await import(
        '@/lib/csv-export/sources.server'
      );
      const context = await authorizeCsvExport(request, 'vulnaware-alerts');
      const filters = buildAlertsExportFilters(new URL(request.url).search);
      const source = csvExportSources.find((candidate) => candidate.id === 'vulnaware-alerts');
      if (!source) throw new Error('Workspace alerts CSV source is not registered.');

      const result = await source.export({ filters }, context);

      expect(context).toEqual({ actorId: 'active-user-1', scopeId: ACTIVE_WORKSPACE_ID });
      expect(filters).toEqual({
        status,
        severity: 'high',
        source: 'manual',
        ...(status === 'open' ? { hideSnoozed: '1', since: '7d' } : {}),
      });
      expect(result.records).toBe(1);
      expect(result.csv).toContain(ACTIVE_WORKSPACE_ID);
      expect(result.csv).not.toContain(FOREIGN_WORKSPACE_ID);

      const expectedWhere: Record<string, unknown> = {
        teamId: ACTIVE_WORKSPACE_ID,
        source: 'manual',
        severity: { in: ['high'] },
      };
      if (status === 'snoozed') expectedWhere.snoozedUntil = { gt: expect.any(Date) };
      else expectedWhere.status = status;

      expect(alertFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining(expectedWhere) }),
      );
      if (status === 'open') {
        const where = alertFindMany.mock.calls[0]?.[0]?.where as {
          AND?: Array<{ OR?: Array<Record<string, unknown>> }>;
        };
        expect(where.AND).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              OR: expect.arrayContaining([
                expect.objectContaining({ createdAt: { gte: expect.any(Date) } }),
              ]),
            }),
          ]),
        );
      }
      expect(workspaceMemberFindFirst).toHaveBeenCalledWith({
        where: {
          id: 'active-member-1',
          workspaceId: ACTIVE_WORKSPACE_ID,
          userId: 'active-user-1',
          status: 'active',
        },
        select: { role: true },
      });
    },
  );
});
