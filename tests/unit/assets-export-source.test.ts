// @polsia:user-owned — Contract coverage for the workspace assets CSV adapter.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CSV_EXPORT_LIMITS } from '../../src/modules/csv-export/contracts';
import {
  CsvAccessError,
  CsvExportError,
  defineCsvSource,
  type CsvExportColumn,
} from '../../src/modules/csv-export/server';
import { decodeCell } from '../../src/modules/csv-export/serialization';
import {
  recordLatestWorkspaceAssetScan,
  serializeLatestAssetScan,
  type LatestAssetScan,
  type WorkspaceAssetScanRow,
} from '../../src/lib/business/assets-latest-scan';

const moduleMocks = vi.hoisted(() => ({
  authGetSession: vi.fn(),
  resolveWorkspace: vi.fn(),
  transaction: vi.fn(),
  workspaceMemberFindFirst: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: moduleMocks.authGetSession } } }));
vi.mock('@/lib/business/dashboard-workspace-context', () => ({
  resolveDashboardWorkspaceContext: moduleMocks.resolveWorkspace,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    $transaction: moduleMocks.transaction,
    workspaceMember: { findFirst: moduleMocks.workspaceMemberFindFirst },
  },
}));

import {
  authorizeCsvExport,
  csvExportSources,
} from '../../src/lib/csv-export/sources.server';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const sourceText = readFileSync(resolve(root, 'src/lib/csv-export/sources.server.ts'), 'utf8');
const routeText = readFileSync(resolve(root, 'src/app/api/assets/export.csv/route.ts'), 'utf8');
const buttonText = readFileSync(
  resolve(root, 'src/components/dashboard/assets-export-button.tsx'),
  'utf8',
);
const pageText = readFileSync(resolve(root, 'src/app/(dashboard)/assets/page.tsx'), 'utf8');

const txMocks = {
  executeRaw: vi.fn(),
  workspaceMemberFindFirst: vi.fn(),
  alertFindMany: vi.fn(),
  vulnerabilityFindingFindMany: vi.fn(),
  alertNoteGroupBy: vi.fn(),
  assetFindMany: vi.fn(),
};

const exportTransaction = {
  $executeRaw: txMocks.executeRaw,
  workspaceMember: { findFirst: txMocks.workspaceMemberFindFirst },
  alert: { findMany: txMocks.alertFindMany },
  vulnerabilityFinding: { findMany: txMocks.vulnerabilityFindingFindMany },
  alertNote: { groupBy: txMocks.alertNoteGroupBy },
  asset: { findMany: txMocks.assetFindMany },
};

interface FixtureRow {
  id: string;
  host: string;
}

const fixtureColumn: CsvExportColumn<FixtureRow> = {
  key: 'host',
  label: 'Host',
  kind: 'text',
  access: 'readonly',
  nullable: false,
  serialize: (row) => row.host,
};

function fixtureSource() {
  return defineCsvSource<FixtureRow, { count: number }>({
    id: 'fixture-assets',
    label: 'Fixture assets',
    schemaVersion: '1',
    columns: [fixtureColumn],
    parseFilters(raw) {
      if (
        typeof raw !== 'object' ||
        raw === null ||
        !('count' in raw) ||
        typeof raw.count !== 'number' ||
        !Number.isSafeInteger(raw.count) ||
        raw.count < 0
      ) {
        return { ok: false };
      }
      return { ok: true, value: { count: raw.count } };
    },
    async authorizeColumns() {
      return ['host'];
    },
    keyOf: (row) => row.id,
    versionOf: (row) => row.host,
    async readRows({ filters }) {
      return Array.from({ length: filters.count }, (_, index) => ({
        id: `asset-${String(index).padStart(5, '0')}`,
        host: `host-${index}`,
      }));
    },
  });
}

const context = { actorId: 'user-fixture', scopeId: 'workspace-fixture' };

const assetSource = csvExportSources.find((source) => source.id === 'vulnaware-assets');
if (!assetSource) throw new Error('workspace asset CSV source was not registered');

function parseCsv(csv: string): string[][] {
  return csv
    .replace(/^\uFEFF/, '')
    .split('\r\n')
    .filter(Boolean)
    .map((line) => line.slice(1, -1).split('\",\"'));
}

function configureAssetExportFixture(options: { includeScans: boolean }) {
  const now = Date.now();
  const hostFixtures = [
    { host: 'service-a.example.test', score: 6.5, severity: 'high', status: 'open' },
    { host: 'service-b.example.test', score: 8, severity: 'high', status: 'open' },
    { host: 'service-c.example.test', score: 5, severity: 'high', status: 'open' },
    { host: 'service-d.example.test', score: 9, severity: 'low', status: 'open' },
    { host: 'service-e.example.test', score: 9, severity: 'high', status: 'resolved' },
  ];
  const alerts = hostFixtures.map((fixture, index) => ({
    id: `alert-${index}`,
    findingId: `finding-${index}`,
    severity: fixture.severity,
    status: fixture.status,
    remediatedAt: null,
  }));
  const currentWorkspaceScans: WorkspaceAssetScanRow[] = hostFixtures.flatMap((fixture, index) => {
    if (!options.includeScans) return [];
    const older = new Date(now - 5 * 24 * 60 * 60 * 1000);
    const newest = new Date(now - 2 * 24 * 60 * 60 * 1000);
    return [
      {
        host: fixture.host,
        scan: {
          id: `scan-${index}-old`,
          teamId: context.scopeId,
          startedAt: older,
          status: 'failed',
        },
      },
      {
        host: fixture.host,
        scan: {
          id: `scan-${index}-new`,
          teamId: context.scopeId,
          startedAt: newest,
          status: index === 1 ? 'failed' : index === 2 ? 'running' : 'completed',
        },
      },
    ];
  });
  if (options.includeScans) {
    currentWorkspaceScans.push({
      host: hostFixtures[0]?.host ?? '',
      scan: {
        id: 'zz-scan-0-new-tie',
        teamId: context.scopeId,
        startedAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
        status: 'failed',
      },
    });
    currentWorkspaceScans.push({
      host: hostFixtures[0]?.host ?? '',
      scan: {
        id: 'zz-cross-workspace-newer',
        teamId: 'other-workspace',
        startedAt: new Date(now - 1 * 24 * 60 * 60 * 1000),
        status: 'running',
      },
    });
    currentWorkspaceScans.push({
      host: hostFixtures[1]?.host ?? '',
      scan: {
        id: 'zz-foreign-completed',
        teamId: 'other-workspace',
        startedAt: new Date(now - 1 * 24 * 60 * 60 * 1000),
        status: 'completed',
      },
    });
  }

  const history = hostFixtures.flatMap((fixture, index) => [
    {
      id: `history-${index}-old`,
      asset: { host: fixture.host },
      scanId: `scan-${index}-old`,
      priorityScore: 2,
      scan: { startedAt: new Date(now - 5 * 24 * 60 * 60 * 1000) },
    },
    {
      id: `history-${index}-new`,
      asset: { host: fixture.host },
      scanId: `scan-${index}-new`,
      priorityScore: 4,
      scan: { startedAt: new Date(now - 2 * 24 * 60 * 60 * 1000) },
    },
  ]);

  txMocks.executeRaw.mockResolvedValue(0);
  txMocks.workspaceMemberFindFirst.mockResolvedValue({ role: 'member' });
  txMocks.alertFindMany.mockResolvedValue(alerts);
  txMocks.vulnerabilityFindingFindMany
    .mockResolvedValueOnce(
      hostFixtures.map((fixture, index) => ({
        id: `finding-${index}`,
        priorityScore: fixture.score,
        asset: { host: fixture.host },
      })),
    )
    .mockResolvedValueOnce(history);
  txMocks.alertNoteGroupBy.mockResolvedValue([]);
  txMocks.assetFindMany.mockResolvedValue(currentWorkspaceScans);
  return { currentWorkspaceScans };
}

beforeEach(() => {
  vi.resetAllMocks();
  moduleMocks.transaction.mockImplementation(async (callback) => callback(exportTransaction));
});

describe('workspace assets CSV adapter', () => {
  it('routes the asset export through the module and sends only active filters', () => {
    expect(routeText).toContain('createCsvExportHandlers');
    expect(routeText).toContain('export const POST = handlers.POST');
    expect(routeText).toContain("Allow: 'POST'");
    expect(buttonText).toContain('sourceId="vulnaware-assets"');
    expect(buttonText).toContain('endpoint="/api/assets/export.csv"');
    expect(pageText).toContain('<AssetsExportButton');
    expect(pageText).toContain('q={searchQuery}');
    expect(pageText).toContain('minRiskScore={minRiskScore}');
    expect(pageText).toContain('scanRecency={scanRecency}');
    expect(pageText).toContain('latestScanStatus={latestScanStatus}');
    expect(pageText).toContain('neverScanned={neverScanned}');
    expect(pageText).toContain('riskTrend={riskTrend}');
    expect(pageText).toContain('alertPresence={alertPresence}');
    expect(pageText).toContain('sort={sort}');
    expect(buttonText).toContain('minRiskScore: number | null');
    expect(buttonText).toContain('scanRecency: AssetScanRecency');
    expect(buttonText).toContain('latestScanStatus: AssetScanStatus | null');
    expect(buttonText).toContain('neverScanned: boolean');
    expect(buttonText).toContain('filters.minRiskScore = String(minRiskScore)');
    expect(buttonText).toContain('filters.scanRecency = scanRecency');
    expect(buttonText).toContain('filters.latestScanStatus = latestScanStatus');
    expect(buttonText).toContain("filters.neverScanned = 'true'");
    expect(buttonText).toContain('filters.riskTrend = riskTrend');
    expect(buttonText).toContain('filters.alertPresence = alertPresence');
  });

  it('keeps the asset source scoped, strict, bounded and ordered like the list', () => {
    const assetSource = sourceText.slice(sourceText.indexOf('interface AssetCsvRow'));
    expect(assetSource).toContain("id: 'vulnaware-assets'");
    expect(assetSource).toContain("key: 'host'");
    expect(assetSource).toContain("key: 'open_alert_count'");
    expect(assetSource).toContain("key: 'last_scan_at'");
    expect(assetSource).toContain("key: 'latest_scan_status'");
    expect(assetSource).toContain("label: 'Latest scan status'");
    expect(assetSource).toContain("schemaVersion: '2'");
    expect(assetSource).toContain("key: 'risk_score'");
    expect(sourceText).toContain('AssetQuery.pick({');
    expect(sourceText).toContain('minRiskScore: true');
    expect(sourceText).toContain('scanRecency: true');
    expect(sourceText).toContain('latestScanStatus: true');
    expect(sourceText).toContain('neverScanned: true');
    expect(sourceText).toContain('riskTrend: true');
    expect(sourceText).toContain('alertPresence: true');
    expect(sourceText).toContain('}).strict()');
    const assetRead = sourceText.slice(
      sourceText.indexOf('async function readScopedAssets'),
      sourceText.indexOf('async function readScopedAssetRiskHistory'),
    );
    expect(assetRead).toContain('output.length >= input.limit');
    expect(assetRead).not.toContain('matchingHosts.size >= input.limit');
    expect(assetRead).toContain('forEachIdPage');
    expect(assetRead).toContain('take: CSV_SUPPORT_READ_BATCH_SIZE');
    expect(assetRead).not.toContain('take: input.limit');
    expect(assetSource).toContain('context.scopeId');
    expect(assetSource).toContain('context.actorId');
    expect(assetSource).toContain('RepeatableRead');
    expect(assetSource).toContain("SET LOCAL statement_timeout = '25000ms'");
    expect(assetSource).toContain("case 'riskScore:asc'");
    expect(assetSource).toContain("case 'riskScoreChange'");
    expect(assetSource).toContain("case 'riskScoreChange:asc'");
    expect(assetSource).toContain('calculateRiskScoreChange');
    expect(assetSource).toContain("case 'lastActivity'");
    expect(assetSource).toContain('matchesAssetScanRecency');
    expect(assetSource).toContain('matchesLatestAssetScanStatus');
    expect(assetSource).toContain('input.filters.neverScanned');
    expect(assetSource).toContain('matchesAssetAlertPresence');
    expect(assetSource).toContain('matchesAssetRiskTrend');
    expect(assetSource).toContain("case 'latestScanAt'");
    expect(assetSource).toContain("case 'latestScanAt:asc'");
    expect(assetSource).toContain('latestScanByHost');
    expect(assetSource).toContain('...serializeLatestAssetScan(latestScan)');
    expect(assetSource).toContain('teamId: true, startedAt: true, status: true');
    expect(assetSource).toContain('row.riskScore >= input.filters.minRiskScore');
    expect(assetSource).not.toContain('pageSize');
  });

  it('exports the same newest workspace scan selected by the inventory', () => {
    const timestamp = new Date('2026-10-20T11:30:00.000Z');
    const latestByHost = new Map<string, LatestAssetScan>();
    const scans: WorkspaceAssetScanRow[] = [
      {
        host: 'api.example.test',
        scan: {
          id: 'scan-a',
          teamId: context.scopeId,
          startedAt: new Date('2026-10-19T11:30:00.000Z'),
          status: 'failed',
        },
      },
      {
        host: 'api.example.test',
        scan: { id: 'scan-z-new', teamId: context.scopeId, startedAt: timestamp, status: 'completed' },
      },
      {
        host: 'api.example.test',
        scan: { id: 'scan-a-new', teamId: context.scopeId, startedAt: timestamp, status: 'running' },
      },
      {
        host: 'api.example.test',
        scan: {
          id: 'scan-other-workspace',
          teamId: 'another-workspace',
          startedAt: new Date('2026-10-21T11:30:00.000Z'),
          status: 'failed',
        },
      },
    ];

    for (const row of scans) recordLatestWorkspaceAssetScan(latestByHost, row, context.scopeId);

    const inventoryScan = latestByHost.get('api.example.test');
    const inventoryDetails = serializeLatestAssetScan(inventoryScan);
    const exportedDetails = serializeLatestAssetScan(inventoryScan);
    expect(exportedDetails).toEqual({
      latestScanAt: '2026-10-20T11:30:00.000Z',
      latestScanStatus: 'completed',
    });
    expect(exportedDetails.latestScanAt).toBe(inventoryDetails.latestScanAt);
    expect(exportedDetails.latestScanStatus).toBe(inventoryDetails.latestScanStatus);
  });

  it('exports all matching rows in selected order while the inventory is on one-row pages', async () => {
    const { currentWorkspaceScans } = configureAssetExportFixture({ includeScans: true });
    const result = await assetSource.export(
      {
        filters: {
          q: 'service',
          workspaceId: 'another-workspace',
          severity: 'high',
          status: 'open',
          minRiskScore: '6.5',
          scanRecency: 'last30d',
          latestScanStatus: 'failed',
          riskTrend: 'rising',
          alertPresence: 'with',
          sort: 'riskScore:asc',
        },
      },
      context,
    );
    const records = parseCsv(result.csv);
    const headers = records[0] ?? [];
    const rows = records.slice(1);
    const index = (key: string) => headers.indexOf(key);
    const decoded = rows.map((row) => ({
      host: decodeCell(row[index('host')] ?? ''),
      lastScanAt: decodeCell(row[index('last_scan_at')] ?? ''),
      latestScanStatus: decodeCell(row[index('latest_scan_status')] ?? ''),
    }));
    const inventoryLatestByHost = new Map<string, LatestAssetScan>();
    for (const scanRow of currentWorkspaceScans) {
      recordLatestWorkspaceAssetScan(inventoryLatestByHost, scanRow, context.scopeId);
    }
    const expected = ['service-a.example.test', 'service-b.example.test'].map((host) => ({
      host,
      lastScanAt: serializeLatestAssetScan(inventoryLatestByHost.get(host)).latestScanAt,
      latestScanStatus: serializeLatestAssetScan(inventoryLatestByHost.get(host)).latestScanStatus,
    }));

    expect(result.records).toBe(2);
    expect(decoded).toEqual(expected);
    expect(decoded.slice(0, 1)).toHaveLength(1);
    expect(decoded).toHaveLength(2);
    expect(decoded.map((row) => row.host)).toEqual([
      'service-a.example.test',
      'service-b.example.test',
    ]);
    expect(decoded[0]).toMatchObject({
      host: 'service-a.example.test',
      latestScanStatus: 'failed',
    });
  });

  it('ignores newer foreign and foreign-only scans in exported values and latest-status filters', async () => {
    const { currentWorkspaceScans } = configureAssetExportFixture({ includeScans: true });
    const foreignOnlyScan: WorkspaceAssetScanRow = {
      host: 'service-c.example.test',
      scan: {
        id: 'zz-foreign-only-newest',
        teamId: 'other-workspace',
        startedAt: new Date(Date.now() + 60_000),
        status: 'queued',
      },
    };
    const scanRows = [
      ...currentWorkspaceScans.filter((row) => row.host !== 'service-c.example.test'),
      foreignOnlyScan,
    ];
    txMocks.assetFindMany.mockReset();
    txMocks.assetFindMany.mockResolvedValue(scanRows);

    const unfilteredByLatestStatus = await assetSource.export(
      {
        filters: {
          q: 'service',
          severity: 'high',
          status: 'open',
          sort: 'name',
        },
      },
      context,
    );
    const records = parseCsv(unfilteredByLatestStatus.csv);
    const headers = records[0] ?? [];
    const hostIndex = headers.indexOf('host');
    const timestampIndex = headers.indexOf('last_scan_at');
    const statusIndex = headers.indexOf('latest_scan_status');
    const rows = records.slice(1).map((row) => ({
      host: decodeCell(row[hostIndex] ?? ''),
      lastScanAt: decodeCell(row[timestampIndex] ?? ''),
      status: decodeCell(row[statusIndex] ?? ''),
    }));
    const inventoryLatestByHost = new Map<string, LatestAssetScan>();
    for (const row of scanRows) recordLatestWorkspaceAssetScan(inventoryLatestByHost, row, context.scopeId);
    const expected = [
      'service-a.example.test',
      'service-b.example.test',
      'service-c.example.test',
    ].map((host) => ({
      host,
      lastScanAt: serializeLatestAssetScan(inventoryLatestByHost.get(host)).latestScanAt,
      status: serializeLatestAssetScan(inventoryLatestByHost.get(host)).latestScanStatus,
    }));

    expect(unfilteredByLatestStatus.records).toBe(3);
    expect(rows).toEqual(expected);
    expect(rows.find((row) => row.host === 'service-c.example.test')).toEqual({
      host: 'service-c.example.test',
      lastScanAt: null,
      status: null,
    });
    expect(JSON.stringify(rows)).not.toContain(foreignOnlyScan.scan.startedAt.toISOString());
    expect(JSON.stringify(rows)).not.toContain('running');
    expect(JSON.stringify(rows)).not.toContain('completed');
    expect(JSON.stringify(rows)).not.toContain('queued');
    expect(txMocks.assetFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ scan: { teamId: context.scopeId } }),
      }),
    );

    txMocks.vulnerabilityFindingFindMany.mockReset();
    configureAssetExportFixture({ includeScans: true });
    txMocks.assetFindMany.mockReset();
    txMocks.assetFindMany.mockResolvedValue(scanRows);
    const filteredByLatestStatus = await assetSource.export(
      {
        filters: {
          q: 'service',
          severity: 'high',
          status: 'open',
          latestScanStatus: 'failed',
          sort: 'name',
        },
      },
      context,
    );
    const filteredRecords = parseCsv(filteredByLatestStatus.csv);
    const filteredHeaders = filteredRecords[0] ?? [];
    const filteredRows = filteredRecords.slice(1).map((row) => ({
      host: decodeCell(row[filteredHeaders.indexOf('host')] ?? ''),
      lastScanAt: decodeCell(row[filteredHeaders.indexOf('last_scan_at')] ?? ''),
      status: decodeCell(row[filteredHeaders.indexOf('latest_scan_status')] ?? ''),
    }));

    expect(filteredByLatestStatus.records).toBe(2);
    expect(filteredRows.map((row) => row.host)).toEqual([
      'service-a.example.test',
      'service-b.example.test',
    ]);
    expect(filteredRows.every((row) => row.status === 'failed')).toBe(true);
    expect(filteredRows.every((row) => row.lastScanAt !== null)).toBe(true);
    expect(filteredRows.some((row) => row.host === 'service-c.example.test')).toBe(false);

    for (const foreignStatus of ['running', 'queued'] as const) {
      txMocks.vulnerabilityFindingFindMany.mockReset();
      configureAssetExportFixture({ includeScans: true });
      txMocks.assetFindMany.mockReset();
      txMocks.assetFindMany.mockResolvedValue(scanRows);
      await expect(
        assetSource.export(
          {
            filters: {
              q: 'service',
              severity: 'high',
              status: 'open',
              latestScanStatus: foreignStatus,
              sort: 'name',
            },
          },
          context,
        ),
      ).rejects.toMatchObject({ code: 'NO_RESULTS' });
    }
  });

  it('exports the full never-scanned filtered result across inventory pages and ignores foreign completions', async () => {
    configureAssetExportFixture({ includeScans: true });
    const result = await assetSource.export(
      {
        filters: {
          q: 'service',
          severity: 'high',
          status: 'open',
          minRiskScore: '5',
          workspaceId: 'another-workspace',
          scanRecency: 'last30d',
          neverScanned: 'true',
          riskTrend: 'rising',
          alertPresence: 'with',
          sort: 'riskScore:asc',
        },
      },
      context,
    );

    const records = parseCsv(result.csv);
    const headers = records[0] ?? [];
    const hostIndex = headers.indexOf('host');
    const hosts = records.slice(1).map((row) => decodeCell(row[hostIndex] ?? ''));

    expect(result.records).toBe(2);
    expect(hosts).toEqual(['service-c.example.test', 'service-b.example.test']);
    expect(txMocks.assetFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ scan: { teamId: context.scopeId } }),
        select: expect.objectContaining({
          scan: { select: { id: true, teamId: true, startedAt: true, status: true } },
        }),
      }),
    );
  });

  it('encodes both scan details as null for an asset with no workspace scan history', async () => {
    configureAssetExportFixture({ includeScans: false });
    const result = await assetSource.export(
      {
        filters: {
          q: 'service-a',
          severity: 'high',
          status: 'open',
          alertPresence: 'with',
          sort: 'name',
        },
      },
      context,
    );
    const records = parseCsv(result.csv);
    const headers = records[0] ?? [];
    const row = records[1] ?? [];

    expect(result.records).toBe(1);
    expect(decodeCell(row[headers.indexOf('host')] ?? '')).toBe('service-a.example.test');
    expect(decodeCell(row[headers.indexOf('last_scan_at')] ?? '')).toBeNull();
    expect(decodeCell(row[headers.indexOf('latest_scan_status')] ?? '')).toBeNull();
  });

  it('registers a strict, host-scoped risk-history source with readonly fields', () => {
    const historySource = sourceText.slice(sourceText.indexOf('const AssetRiskHistoryFiltersSchema'));
    expect(historySource).toContain("id: 'vulnaware-asset-risk-history'");
    expect(historySource).toContain("key: 'scanned_at'");
    expect(historySource).toContain("label: 'Scanned at'");
    expect(historySource).toContain("key: 'risk_score'");
    expect(historySource).toContain("label: 'Risk score'");
    expect(historySource).toContain("access: 'readonly'");
    expect(historySource).toContain('AssetRiskHistoryFiltersSchema');
    expect(historySource).toContain('decodeURIComponent');
    expect(historySource).toContain('.toLowerCase().trim()');
    expect(historySource).toContain('AssetDetailPathParam.safeParse');
    expect(historySource).toContain('tx.scan.findMany');
    expect(historySource).toContain('take: input.limit');
    expect(historySource).toContain('tx.vulnerabilityFinding.findMany');
    expect(historySource).toContain('groupAssetRiskFindings');
    expect(historySource).toContain('Prisma.TransactionIsolationLevel.RepeatableRead');
    expect(historySource).toContain("SET LOCAL statement_timeout = '25000ms'");
    expect(historySource).toContain('context.scopeId');
    expect(historySource).toContain('context.actorId');
    expect(sourceText).toContain("sourceId !== 'vulnaware-asset-risk-history'");
  });

  it('keeps module field authorization and record limits intact', async () => {
    const source = fixtureSource();
    await expect(
      source.export({ filters: { count: 1 }, columns: ['secret'] }, context),
    ).rejects.toBeInstanceOf(CsvAccessError);
    await expect(
      source.export({ filters: { count: CSV_EXPORT_LIMITS.records + 1 } }, context),
    ).rejects.toMatchObject({ code: 'ROW_LIMIT' });
    await expect(source.export({ filters: { count: 0 } }, context)).rejects.toMatchObject({
      code: 'NO_RESULTS',
    });
  });
});

describe('workspace asset CSV authorization', () => {
  const request = new Request('https://app.example.test/api/csv-export', { method: 'POST' });

  it('rejects anonymous, nonmember, and viewer exports', async () => {
    moduleMocks.authGetSession.mockResolvedValueOnce(null);
    await expect(authorizeCsvExport(request, 'vulnaware-assets')).rejects.toMatchObject({
      status: 401,
    });

    moduleMocks.authGetSession.mockResolvedValue({ user: { id: 'user-fixture' } });
    moduleMocks.resolveWorkspace.mockResolvedValueOnce({
      workspaceId: context.scopeId,
      workspaceMemberId: null,
    });
    await expect(authorizeCsvExport(request, 'vulnaware-assets')).rejects.toMatchObject({
      status: 403,
    });

    moduleMocks.resolveWorkspace.mockResolvedValueOnce({
      workspaceId: context.scopeId,
      workspaceMemberId: 'membership-fixture',
    });
    moduleMocks.workspaceMemberFindFirst.mockResolvedValueOnce({ role: 'viewer' });
    await expect(authorizeCsvExport(request, 'vulnaware-assets')).rejects.toMatchObject({
      status: 403,
    });
  });

  it('derives export scope from the active member workspace', async () => {
    moduleMocks.authGetSession.mockResolvedValue({ user: { id: 'user-fixture' } });
    moduleMocks.resolveWorkspace.mockResolvedValue({
      workspaceId: context.scopeId,
      workspaceMemberId: 'membership-fixture',
    });
    moduleMocks.workspaceMemberFindFirst.mockResolvedValue({ role: 'member' });

    await expect(authorizeCsvExport(request, 'vulnaware-assets')).resolves.toEqual(context);
    expect(moduleMocks.workspaceMemberFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'membership-fixture',
        workspaceId: context.scopeId,
        userId: 'user-fixture',
        status: 'active',
      },
      select: { role: true },
    });
  });

  it('ignores client-supplied workspace ids and still validates other filter keys strictly', async () => {
    configureAssetExportFixture({ includeScans: true });
    const result = await assetSource.export(
      { filters: { workspaceId: 'another-workspace', neverScanned: 'true', sort: 'name' } },
      context,
    );
    const records = parseCsv(result.csv);
    const headers = records[0] ?? [];
    const hostIndex = headers.indexOf('host');
    const hosts = records.slice(1).map((row) => decodeCell(row[hostIndex] ?? ''));

    expect(hosts).toEqual(['service-b.example.test', 'service-c.example.test']);
    expect(txMocks.assetFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ scan: { teamId: context.scopeId } }),
      }),
    );

    const transactionCalls = moduleMocks.transaction.mock.calls.length;
    await expect(
      assetSource.export({ filters: { workspaceId: 'another-workspace', extraFilter: 'ignored?' } }, context),
    ).rejects.toMatchObject({ code: 'INVALID_FILTERS' });
    expect(moduleMocks.transaction).toHaveBeenCalledTimes(transactionCalls);
  });
});
