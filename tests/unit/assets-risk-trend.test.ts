// @vitest-environment node
// Scan-scoped persisted risk-score history query coverage.

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FindingRow {
  scanId: string;
  priorityScore: number | null;
  scan: { startedAt: Date };
  asset?: { host: string };
}

interface QueryArg {
  where: {
    priorityScore: { not: null };
    asset: { host: string | { in: string[] } };
    scan: { teamId: string; startedAt: { gte: Date; lte: Date } };
  };
  select: Record<string, unknown>;
  orderBy?: Array<Record<string, unknown>>;
}

const findManyMock = vi.hoisted(() =>
  vi.fn<(query: QueryArg) => Promise<FindingRow[]>>(),
);

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({
  prisma: { vulnerabilityFinding: { findMany: findManyMock } },
}));

import {
  groupAssetRiskFindings,
  loadAssetRiskChanges,
  loadAssetRiskTrend,
  matchesAssetRiskTrend,
} from '@/lib/business/assets-risk-trend';

const TEAM_ID = 'team-current';
const HOST = 'scan-target.example.invalid';
const NOW = new Date('2026-09-29T12:00:00.000Z');
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

describe('groupAssetRiskFindings', () => {
  it('keeps the maximum score per scan and sorts by date then scan ID', () => {
    const scannedAt = new Date('2026-09-10T09:30:00.000Z');
    expect(
      groupAssetRiskFindings([
        { scanId: 'scan-b', priorityScore: 4, scan: { startedAt: scannedAt } },
        { scanId: 'scan-b', priorityScore: 9, scan: { startedAt: scannedAt } },
        { scanId: 'scan-a', priorityScore: 3, scan: { startedAt: scannedAt } },
        {
          scanId: 'scan-old',
          priorityScore: 8,
          scan: { startedAt: new Date('2026-09-01T00:00:00.000Z') },
        },
      ]),
    ).toEqual([
      { scanId: 'scan-old', scannedAt: new Date('2026-09-01T00:00:00.000Z'), score: 8 },
      { scanId: 'scan-a', scannedAt, score: 3 },
      { scanId: 'scan-b', scannedAt, score: 9 },
    ]);
  });
});

describe('matchesAssetRiskTrend', () => {
  it.each([
    ['rising', 1, true],
    ['rising', -1, false],
    ['falling', -1, true],
    ['falling', 1, false],
    ['unchanged', 0, true],
    ['unchanged', 1, false],
  ] as const)('matches %s against %s as %s', (trend, change, expected) => {
    expect(matchesAssetRiskTrend(change, trend)).toBe(expected);
  });

  it('keeps null history only when the filter is absent', () => {
    expect(matchesAssetRiskTrend(null, undefined)).toBe(true);
    expect(matchesAssetRiskTrend(null, 'rising')).toBe(false);
  });
});

beforeEach(() => {
  findManyMock.mockReset();
  findManyMock.mockResolvedValue([]);
});

describe('loadAssetRiskTrend', () => {
  it('groups persisted finding scores by scan, keeps each maximum, and orders dated points', async () => {
    const oldest = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
    const middle = new Date('2026-09-10T09:30:00.000Z');
    const newest = new Date('2026-09-28T18:15:00.000Z');
    findManyMock.mockResolvedValue([
      { scanId: 'scan-newest', priorityScore: 4.3, scan: { startedAt: newest } },
      { scanId: 'scan-middle', priorityScore: null, scan: { startedAt: middle } },
      { scanId: 'scan-middle', priorityScore: 6.75, scan: { startedAt: middle } },
      { scanId: 'scan-middle', priorityScore: 8.25, scan: { startedAt: middle } },
      { scanId: 'scan-oldest', priorityScore: 2.5, scan: { startedAt: oldest } },
    ]);

    const data = await loadAssetRiskTrend(TEAM_ID, HOST, NOW);

    expect(data).toEqual({
      host: HOST,
      series: [
        { scannedAt: oldest.toISOString(), score: 2.5 },
        { scannedAt: middle.toISOString(), score: 8.25 },
        { scannedAt: newest.toISOString(), score: 4.3 },
      ],
    });
    const query = findManyMock.mock.calls[0]?.[0];
    expect(query?.where).toEqual({
      priorityScore: { not: null },
      asset: { host: HOST },
      scan: {
        teamId: TEAM_ID,
        startedAt: {
          gte: new Date(NOW.getTime() - THIRTY_DAYS_MS),
          lte: NOW,
        },
      },
    });
    expect(query?.select).toEqual({
      scanId: true,
      priorityScore: true,
      scan: { select: { startedAt: true } },
    });
    expect(query?.orderBy).toEqual([{ scan: { startedAt: 'asc' } }, { scanId: 'asc' }]);
  });

  it('returns an empty series when no scored findings qualify', async () => {
    findManyMock.mockResolvedValue([
      { scanId: 'scan-null-score', priorityScore: null, scan: { startedAt: NOW } },
    ]);

    await expect(loadAssetRiskTrend(TEAM_ID, HOST, NOW)).resolves.toEqual({
      host: HOST,
      series: [],
    });
  });

  it('includes scans on both 30-day boundaries and excludes scans immediately outside them', async () => {
    const lowerBound = new Date(NOW.getTime() - THIRTY_DAYS_MS);
    const fixtures = [
      { scanId: 'just-before', priorityScore: 9, scan: { startedAt: new Date(lowerBound.getTime() - 1) } },
      { scanId: 'at-lower-bound', priorityScore: 3, scan: { startedAt: lowerBound } },
      { scanId: 'at-upper-bound', priorityScore: 7, scan: { startedAt: NOW } },
      { scanId: 'just-after', priorityScore: 10, scan: { startedAt: new Date(NOW.getTime() + 1) } },
    ];
    findManyMock.mockImplementation(async (query) =>
      fixtures.filter(
        (row) =>
          row.priorityScore !== null &&
          row.scan.startedAt >= query.where.scan.startedAt.gte &&
          row.scan.startedAt <= query.where.scan.startedAt.lte,
      ),
    );

    const data = await loadAssetRiskTrend(TEAM_ID, HOST, NOW);

    expect(data.series).toEqual([
      { scannedAt: lowerBound.toISOString(), score: 3 },
      { scannedAt: NOW.toISOString(), score: 7 },
    ]);
  });

  it('uses a fresh current timestamp when no clock override is supplied', async () => {
    const before = Date.now();
    await loadAssetRiskTrend(TEAM_ID, HOST);
    const after = Date.now();
    const query = findManyMock.mock.calls[0]?.[0];
    if (!query) throw new Error('Expected the Prisma query to be issued.');
    const bounds = query.where.scan.startedAt;

    expect(bounds.gte.getTime()).toBeGreaterThanOrEqual(before - THIRTY_DAYS_MS - 5);
    expect(bounds.gte.getTime()).toBeLessThanOrEqual(after - THIRTY_DAYS_MS + 5);
    expect(bounds.lte.getTime()).toBeGreaterThanOrEqual(before);
    expect(bounds.lte.getTime()).toBeLessThanOrEqual(after);
  });
});

describe('loadAssetRiskChanges', () => {
  it('does not query scan history when there are no requested hosts', async () => {
    await expect(loadAssetRiskChanges(TEAM_ID, [], NOW)).resolves.toEqual(new Map());
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it('groups requested hosts by scan, keeps each maximum, and returns unavailable hosts', async () => {
    const oldest = new Date('2026-09-01T12:00:00.000Z');
    const newest = new Date('2026-09-28T12:00:00.000Z');
    findManyMock.mockResolvedValue([
      {
        asset: { host: HOST },
        scanId: 'scan-oldest',
        priorityScore: 2,
        scan: { startedAt: oldest },
      },
      {
        asset: { host: HOST },
        scanId: 'scan-oldest',
        priorityScore: 7.25,
        scan: { startedAt: oldest },
      },
      {
        asset: { host: HOST },
        scanId: 'scan-newest',
        priorityScore: 4.5,
        scan: { startedAt: newest },
      },
      {
        asset: { host: 'one-point.example.invalid' },
        scanId: 'scan-only',
        priorityScore: 5,
        scan: { startedAt: newest },
      },
      {
        asset: { host: 'invalid-date.example.invalid' },
        scanId: 'scan-invalid',
        priorityScore: 9,
        scan: { startedAt: new Date('invalid') },
      },
    ]);

    const changes = await loadAssetRiskChanges(
      TEAM_ID,
      [HOST, 'one-point.example.invalid', 'missing.example.invalid'],
      NOW,
    );

    expect(changes).toEqual(
      new Map([
        [HOST, -2.75],
        ['one-point.example.invalid', null],
        ['missing.example.invalid', null],
      ]),
    );
    expect(findManyMock).toHaveBeenCalledWith({
      where: {
        priorityScore: { not: null },
        asset: { host: { in: [HOST, 'one-point.example.invalid', 'missing.example.invalid'] } },
        scan: {
          teamId: TEAM_ID,
          startedAt: {
            gte: new Date(NOW.getTime() - THIRTY_DAYS_MS),
            lte: NOW,
          },
        },
      },
      select: {
        asset: { select: { host: true } },
        scanId: true,
        priorityScore: true,
        scan: { select: { startedAt: true } },
      },
    });
  });

  it('includes both inclusive 30-day bounds and ignores zero usable points', async () => {
    const lowerBound = new Date(NOW.getTime() - THIRTY_DAYS_MS);
    const fixtures: FindingRow[] = [
      {
        asset: { host: HOST },
        scanId: 'just-before',
        priorityScore: 9,
        scan: { startedAt: new Date(lowerBound.getTime() - 1) },
      },
      {
        asset: { host: HOST },
        scanId: 'at-lower-bound',
        priorityScore: 3,
        scan: { startedAt: lowerBound },
      },
      {
        asset: { host: HOST },
        scanId: 'at-upper-bound',
        priorityScore: 7,
        scan: { startedAt: NOW },
      },
    ];
    findManyMock.mockImplementation(async (query) =>
      fixtures.filter(
        (row) =>
          row.priorityScore !== null &&
          row.scan.startedAt >= query.where.scan.startedAt.gte &&
          row.scan.startedAt <= query.where.scan.startedAt.lte,
      ),
    );

    await expect(loadAssetRiskChanges(TEAM_ID, [HOST], NOW)).resolves.toEqual(
      new Map([[HOST, 4]]),
    );
  });
});
