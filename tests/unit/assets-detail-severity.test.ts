// @vitest-environment node
// @polsia:user-owned — Unresolved asset severity aggregation coverage.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldUnresolvedSeverityCounts,
  loadAssetDetail,
  UNRESOLVED_ALERT_STATUSES,
} from '@/lib/business/assets-detail';

const { alertFindMany, alertCount, alertGroupBy, scanFindMany } = vi.hoisted(() => ({
  alertFindMany: vi.fn(),
  alertCount: vi.fn(),
  alertGroupBy: vi.fn(),
  scanFindMany: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({
  prisma: {
    alert: {
      findMany: alertFindMany,
      count: alertCount,
      groupBy: alertGroupBy,
    },
    scan: { findMany: scanFindMany },
  },
}));

describe('asset detail unresolved severity counts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('folds every standard severity and maps legacy values to low', () => {
    expect(
      foldUnresolvedSeverityCounts([
        { severity: 'critical', _count: 2 },
        { severity: 'high', _count: 3 },
        { severity: 'medium', _count: 4 },
        { severity: 'low', _count: 5 },
        { severity: 'legacy-value', _count: 6 },
        { severity: null, _count: 7 },
      ]),
    ).toEqual({ critical: 2, high: 3, medium: 4, low: 18 });
  });

  it('counts open and in-progress rows while excluding resolved and false positives', () => {
    const rows = [
      { severity: 'critical', status: 'open', _count: 1 },
      { severity: 'high', status: 'in_progress', _count: 2 },
      { severity: 'medium', status: 'resolved', _count: 4 },
      { severity: 'low', status: 'false_positive', _count: 8 },
    ];
    const unresolvedGroups = rows
      .filter((row) =>
        (UNRESOLVED_ALERT_STATUSES as readonly string[]).includes(row.status),
      )
      .map(({ severity, _count }) => ({ severity, _count }));

    expect(foldUnresolvedSeverityCounts(unresolvedGroups)).toEqual({
      critical: 1,
      high: 2,
      medium: 0,
      low: 0,
    });
  });

  it('zero-fills all buckets for an empty unresolved set', () => {
    expect(foldUnresolvedSeverityCounts([])).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    });
  });

  it('queries only unresolved alerts in the active workspace and host scope', async () => {
    alertFindMany.mockResolvedValue([]);
    alertCount.mockResolvedValue(0);
    alertGroupBy.mockResolvedValue([
      { severity: 'critical', _count: 1 },
      { severity: 'high', _count: 2 },
    ]);
    scanFindMany.mockResolvedValue([]);

    await loadAssetDetail('active-workspace', 'asset.example');

    expect(alertGroupBy).toHaveBeenCalledWith({
      by: ['severity'],
      where: {
        teamId: 'active-workspace',
        findingId: { not: 'manual' },
        status: { in: UNRESOLVED_ALERT_STATUSES },
        finding: { asset: { host: 'asset.example', scan: { teamId: 'active-workspace' } } },
      },
      _count: true,
    });
    expect(alertGroupBy.mock.calls[0]?.[0]?.where.status.in).toEqual(['open', 'in_progress']);
    expect(scanFindMany).toHaveBeenCalledWith({
      where: { teamId: 'active-workspace', assets: { some: { host: 'asset.example' } } },
      orderBy: { startedAt: 'desc' },
      take: 5,
      select: { id: true, status: true, startedAt: true, finishedAt: true },
    });
  });

  it('maps the newest scoped scan status and timestamp from the same row', async () => {
    alertFindMany.mockResolvedValue([
      {
        id: 'alert-1',
        severity: 'low',
        status: 'open',
        createdAt: new Date('2026-09-01T00:00:00Z'),
        acknowledgedAt: null,
        remediatedAt: null,
        snoozedUntil: null,
        finding: {
          cveId: 'CVE-2026-0001',
          asset: { host: 'asset.example', port: 443, protocol: 'tcp', serviceHint: 'https' },
        },
      },
    ]);
    alertCount.mockResolvedValue(1);
    alertGroupBy.mockResolvedValue([]);
    const startedAt = new Date('2026-09-02T12:30:00Z');
    scanFindMany.mockResolvedValue([
      { id: 'scan-1', startedAt, finishedAt: new Date('2026-09-02T12:31:00Z'), status: 'completed' },
    ]);

    const detail = await loadAssetDetail('active-workspace', 'asset.example');

    expect(detail.latestScanAt).toBe(startedAt.toISOString());
    expect(detail.latestScanStatus).toBe('completed');
    expect(detail.recentScans).toEqual([
      {
        id: 'scan-1',
        status: 'completed',
        startedAt: startedAt.toISOString(),
        finishedAt: '2026-09-02T12:31:00.000Z',
      },
    ]);
    expect(scanFindMany).toHaveBeenCalledWith({
      where: { teamId: 'active-workspace', assets: { some: { host: 'asset.example' } } },
      orderBy: { startedAt: 'desc' },
      take: 5,
      select: { id: true, status: true, startedAt: true, finishedAt: true },
    });
  });

  it('keeps the latest scan status null when the stored value is absent', async () => {
    alertFindMany.mockResolvedValue([
      {
        id: 'alert-1',
        severity: 'low',
        status: 'open',
        createdAt: new Date('2026-09-01T00:00:00Z'),
        acknowledgedAt: null,
        remediatedAt: null,
        snoozedUntil: null,
        finding: {
          cveId: 'CVE-2026-0001',
          asset: { host: 'asset.example', port: 443, protocol: 'tcp', serviceHint: 'https' },
        },
      },
    ]);
    alertCount.mockResolvedValue(1);
    alertGroupBy.mockResolvedValue([]);
    scanFindMany.mockResolvedValue([]);

    const detail = await loadAssetDetail('active-workspace', 'asset.example');

    expect(detail.latestScanStatus).toBeNull();
    expect(detail.recentScans).toEqual([]);
  });

  it('returns the five newest scans with mixed statuses and nullable finish times', async () => {
    alertFindMany.mockResolvedValue([
      {
        id: 'alert-1',
        severity: 'low',
        status: 'open',
        createdAt: new Date('2026-09-01T00:00:00Z'),
        acknowledgedAt: null,
        remediatedAt: null,
        snoozedUntil: null,
        finding: {
          cveId: 'CVE-2026-0001',
          asset: { host: 'asset.example', port: 443, protocol: 'tcp', serviceHint: 'https' },
        },
      },
    ]);
    alertCount.mockResolvedValue(1);
    alertGroupBy.mockResolvedValue([]);
    const scans = Array.from({ length: 5 }, (_, index) => ({
      id: `scan-${index}`,
      status: (['failed', 'running', 'completed', 'queued', 'completed'] as const)[index],
      startedAt: new Date(`2026-09-0${5 - index}T12:00:00Z`),
      finishedAt: index === 1 ? null : new Date(`2026-09-0${5 - index}T12:05:00Z`),
    }));
    scanFindMany.mockResolvedValue(scans);

    const detail = await loadAssetDetail('active-workspace', 'asset.example');

    expect(detail.recentScans).toEqual([
      {
        id: 'scan-0',
        status: 'failed',
        startedAt: '2026-09-05T12:00:00.000Z',
        finishedAt: '2026-09-05T12:05:00.000Z',
      },
      {
        id: 'scan-1',
        status: 'running',
        startedAt: '2026-09-04T12:00:00.000Z',
        finishedAt: null,
      },
      {
        id: 'scan-2',
        status: 'completed',
        startedAt: '2026-09-03T12:00:00.000Z',
        finishedAt: '2026-09-03T12:05:00.000Z',
      },
      {
        id: 'scan-3',
        status: 'queued',
        startedAt: '2026-09-02T12:00:00.000Z',
        finishedAt: '2026-09-02T12:05:00.000Z',
      },
      {
        id: 'scan-4',
        status: 'completed',
        startedAt: '2026-09-01T12:00:00.000Z',
        finishedAt: '2026-09-01T12:05:00.000Z',
      },
    ]);
    expect(detail.latestScanStatus).toBe('failed');
    expect(detail.latestScanAt).toBe('2026-09-05T12:00:00.000Z');
  });

  it('defines unresolved as open and in_progress only', () => {
    expect(UNRESOLVED_ALERT_STATUSES).toEqual(['open', 'in_progress']);
    expect(UNRESOLVED_ALERT_STATUSES).not.toContain('resolved');
    expect(UNRESOLVED_ALERT_STATUSES).not.toContain('false_positive');
  });
});
