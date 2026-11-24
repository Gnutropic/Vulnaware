// @vitest-environment node
// Unit tests for the daily CVE velocity trend selector + writer.
// Mirrors tests/unit/scanner/alerts-rescore.test.ts posture — vi.mock
// `server-only` and `@/lib/db`, then drive the selector / writer with
// deterministic inputs so the algorithm stays pinned even as the data
// plane changes.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const alertFindMany = vi.fn();
const teamFindMany = vi.fn();
const vulnerabilityTrendUpsert = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    alert: { findMany: alertFindMany },
    team: { findMany: teamFindMany },
    vulnerabilityTrend: { upsert: vulnerabilityTrendUpsert },
  },
}));

function makeAlert(
  cveId: string,
  host: string,
  port: number,
  createdAt: Date,
): {
  id: string;
  createdAt: Date;
  finding: { cveId: string; asset: { host: string; port: number } };
} {
  return {
    id: `alert-${createdAt.toISOString()}-${cveId}-${host}-${port}`,
    createdAt,
    finding: { cveId, asset: { host, port } },
  };
}

beforeEach(() => {
  vi.resetModules();
  alertFindMany.mockReset();
  teamFindMany.mockReset();
  vulnerabilityTrendUpsert.mockReset();
  vulnerabilityTrendUpsert.mockResolvedValue({});
});

const NOW = new Date('2026-03-15T12:00:00Z');

describe('computeWorkspaceTrend', () => {
  it('returns zero velocity and empty arrays when both windows are empty', async () => {
    alertFindMany.mockResolvedValue([]).mockResolvedValue([]);

    const { computeWorkspaceTrend } = await import('@/lib/business/alerts-trend');
    const signal = await computeWorkspaceTrend('team-1', NOW);

    expect(signal.velocity).toBe(0);
    expect(signal.acceleratingDeclines).toEqual([]);
    expect(signal.hotspots).toEqual([]);
  });

  it('computes positive velocity when recent > prior', async () => {
    // 5 recent, 1 prior → velocity = 4
    const recent = [
      makeAlert('CVE-2025-0001', 'a', 443, new Date('2026-03-14T00:00:00Z')),
      makeAlert('CVE-2025-0001', 'a', 443, new Date('2026-03-13T00:00:00Z')),
      makeAlert('CVE-2025-0001', 'b', 443, new Date('2026-03-12T00:00:00Z')),
      makeAlert('CVE-2025-0002', 'a', 443, new Date('2026-03-11T00:00:00Z')),
      makeAlert('CVE-2025-0003', 'c', 80, new Date('2026-03-10T00:00:00Z')),
    ];
    const prior = [makeAlert('CVE-2025-9999', 'x', 22, new Date('2026-02-20T00:00:00Z'))];
    alertFindMany.mockResolvedValueOnce(recent).mockResolvedValueOnce(prior);

    const { computeWorkspaceTrend } = await import('@/lib/business/alerts-trend');
    const signal = await computeWorkspaceTrend('team-1', NOW);

    expect(signal.velocity).toBe(4);
    // Hotspots sorted by count desc → a:443 (3), then b:443 (1), then c:80 (1)
    expect(signal.hotspots).toEqual([
      { host: 'a', port: 443, count: 3 },
      { host: 'b', port: 443, count: 1 },
      { host: 'c', port: 80, count: 1 },
    ]);
  });

  it('computes negative velocity when recent < prior', async () => {
    // 1 recent, 4 prior → velocity = -3
    const recent = [makeAlert('CVE-2025-0001', 'a', 443, new Date('2026-03-14T00:00:00Z'))];
    const prior = [
      makeAlert('CVE-2025-0001', 'a', 443, new Date('2026-02-20T00:00:00Z')),
      makeAlert('CVE-2025-0002', 'b', 80, new Date('2026-02-19T00:00:00Z')),
      makeAlert('CVE-2025-0003', 'c', 22, new Date('2026-02-18T00:00:00Z')),
      makeAlert('CVE-2025-0004', 'd', 21, new Date('2026-02-17T00:00:00Z')),
    ];
    alertFindMany.mockResolvedValueOnce(recent).mockResolvedValueOnce(prior);

    const { computeWorkspaceTrend } = await import('@/lib/business/alerts-trend');
    const signal = await computeWorkspaceTrend('team-1', NOW);

    expect(signal.velocity).toBe(-3);
  });

  it('computes zero velocity when recent equals prior (count match)', async () => {
    const recent = [makeAlert('CVE-2025-0001', 'a', 443, new Date('2026-03-14T00:00:00Z'))];
    const prior = [makeAlert('CVE-2025-0001', 'a', 443, new Date('2026-02-20T00:00:00Z'))];
    alertFindMany.mockResolvedValueOnce(recent).mockResolvedValueOnce(prior);

    const { computeWorkspaceTrend } = await import('@/lib/business/alerts-trend');
    const signal = await computeWorkspaceTrend('team-1', NOW);
    expect(signal.velocity).toBe(0);
  });

  it('hotspots: top N with alpha tie-break on (host, port)', async () => {
    // Build 6 distinct host:port pairs each count=1 → top 5 returned.
    const recent = [
      makeAlert('CVE-2025-0001', 'a.example', 443, new Date('2026-03-14T00:00:00Z')),
      makeAlert('CVE-2025-0001', 'b.example', 443, new Date('2026-03-13T00:00:00Z')),
      makeAlert('CVE-2025-0001', 'c.example', 80, new Date('2026-03-12T00:00:00Z')),
      makeAlert('CVE-2025-0001', 'a.example', 80, new Date('2026-03-11T00:00:00Z')),
      makeAlert('CVE-2025-0001', 'a.example', 22, new Date('2026-03-10T00:00:00Z')),
      makeAlert('CVE-2025-0001', 'z.example', 443, new Date('2026-03-09T00:00:00Z')),
    ];
    alertFindMany.mockResolvedValueOnce(recent).mockResolvedValueOnce([]);

    const { computeWorkspaceTrend } = await import('@/lib/business/alerts-trend');
    const signal = await computeWorkspaceTrend('team-1', NOW);

    expect(signal.hotspots).toHaveLength(5);
    // All counts are 1 — sort by host asc, then port asc within a host.
    // z.example:443 is dropped (last after alpha).
    expect(signal.hotspots.map((h) => `${h.host}:${h.port}`)).toEqual([
      'a.example:22',
      'a.example:80',
      'a.example:443',
      'b.example:443',
      'c.example:80',
    ]);
  });

  it('acceleratingDeclines = CVEs whose prior count > 0 AND recent count is 0', async () => {
    // CVE-A appears in prior (3x) but never in recent → accelerating.
    // CVE-B appears in BOTH prior + recent → NOT accelerating.
    // CVE-C appears only in recent → cannot be accelerating (no prior signal).
    const recent = [
      makeAlert('CVE-B', 'b', 443, new Date('2026-03-14T00:00:00Z')),
      makeAlert('CVE-C', 'c', 443, new Date('2026-03-13T00:00:00Z')),
    ];
    const prior = [
      makeAlert('CVE-A', 'a', 443, new Date('2026-02-20T00:00:00Z')),
      makeAlert('CVE-A', 'a', 443, new Date('2026-02-19T00:00:00Z')),
      makeAlert('CVE-A', 'a', 443, new Date('2026-02-18T00:00:00Z')),
      makeAlert('CVE-B', 'b', 443, new Date('2026-02-17T00:00:00Z')),
    ];
    alertFindMany.mockResolvedValueOnce(recent).mockResolvedValueOnce(prior);

    const { computeWorkspaceTrend } = await import('@/lib/business/alerts-trend');
    const signal = await computeWorkspaceTrend('team-1', NOW);

    expect(signal.acceleratingDeclines).toEqual(['CVE-A']);
  });

  it('acceleratingDeclines sorts loudest declines first (prior count desc)', async () => {
    // CVE-LOUD has 5 prior hits, CVE-QUIET has 1.
    const recent = [makeAlert('CVE-PRESENT', 'a', 443, new Date('2026-03-14T00:00:00Z'))];
    const prior: ReturnType<typeof makeAlert>[] = [];
    for (let i = 0; i < 5; i++) {
      prior.push(makeAlert('CVE-LOUD', 'a', 443, new Date(`2026-02-${20 + i}T00:00:00Z`)));
    }
    prior.push(makeAlert('CVE-QUIET', 'a', 443, new Date('2026-02-15T00:00:00Z')));
    alertFindMany.mockResolvedValueOnce(recent).mockResolvedValueOnce(prior);

    const { computeWorkspaceTrend } = await import('@/lib/business/alerts-trend');
    const signal = await computeWorkspaceTrend('team-1', NOW);

    expect(signal.acceleratingDeclines).toEqual(['CVE-LOUD', 'CVE-QUIET']);
  });
});

describe('recordWorkspaceTrends — writer idempotency', () => {
  it('returns zero counts when there are no teams', async () => {
    teamFindMany.mockResolvedValueOnce([]);

    const { recordWorkspaceTrends } = await import('@/lib/business/alerts-trend');
    const result = await recordWorkspaceTrends(NOW);
    expect(result).toEqual({ written: 0, failed: 0 });
    expect(vulnerabilityTrendUpsert).not.toHaveBeenCalled();
  });

  it('writes one upsert per team using trimmed UTC windowStart as the idempotency key', async () => {
    teamFindMany.mockResolvedValueOnce([{ id: 'team-1' }, { id: 'team-2' }]);
    // For each team two alert reads + one upsert.
    alertFindMany.mockResolvedValue([]);
    vulnerabilityTrendUpsert.mockResolvedValue({});

    const { recordWorkspaceTrends } = await import('@/lib/business/alerts-trend');
    const result = await recordWorkspaceTrends(NOW);

    expect(result.written).toBe(2);
    expect(result.failed).toBe(0);
    expect(vulnerabilityTrendUpsert).toHaveBeenCalledTimes(2);
    const first = vulnerabilityTrendUpsert.mock.calls[0]?.[0] as {
      where: { workspaceId_windowStart: { workspaceId: string; windowStart: Date } };
      create: { windowEnd: Date; computedAt: Date };
    };
    expect(first.where.workspaceId_windowStart.workspaceId).toBe('team-1');
    // windowStart must be truncated to UTC midnight (30 days back from
    // 2026-03-15T12:00:00Z is 2026-02-13T12:00:00Z, truncated → 2026-02-13T00:00:00Z).
    expect(first.where.workspaceId_windowStart.windowStart.toISOString()).toBe(
      '2026-02-13T00:00:00.000Z',
    );
    expect(first.create.windowEnd.toISOString()).toBe(NOW.toISOString());
    expect(first.create.computedAt.toISOString()).toBe(NOW.toISOString());
  });

  it('isolates a per-team failure (one bad team does not abort the batch)', async () => {
    teamFindMany.mockResolvedValueOnce([{ id: 'team-1' }, { id: 'team-2' }]);
    alertFindMany.mockResolvedValue([]);
    // First call rejects (team-1), second call resolves (team-2).
    vulnerabilityTrendUpsert
      .mockRejectedValueOnce(new Error('transient db blip'))
      .mockResolvedValueOnce({});

    const { recordWorkspaceTrends } = await import('@/lib/business/alerts-trend');
    const result = await recordWorkspaceTrends(NOW);

    expect(result.written).toBe(1);
    expect(result.failed).toBe(1);
    expect(vulnerabilityTrendUpsert).toHaveBeenCalledTimes(2);
  });

  it('two same-day invocations use the same composite key → upsert is stable', async () => {
    teamFindMany.mockResolvedValue([{ id: 'team-1' }]);
    alertFindMany.mockResolvedValue([]);
    vulnerabilityTrendUpsert.mockResolvedValue({});

    const { recordWorkspaceTrends } = await import('@/lib/business/alerts-trend');
    // Same exact `now` for both invocations → identical windowStart.
    await recordWorkspaceTrends(NOW);
    await recordWorkspaceTrends(NOW);

    expect(vulnerabilityTrendUpsert).toHaveBeenCalledTimes(2);
    const firstWhere = (
      vulnerabilityTrendUpsert.mock.calls[0]?.[0] as {
        where: { workspaceId_windowStart: { workspaceId: string; windowStart: Date } };
      }
    ).where.workspaceId_windowStart;
    const secondWhere = (
      vulnerabilityTrendUpsert.mock.calls[1]?.[0] as {
        where: { workspaceId_windowStart: { workspaceId: string; windowStart: Date } };
      }
    ).where.workspaceId_windowStart;
    expect(firstWhere.workspaceId).toBe(secondWhere.workspaceId);
    expect(firstWhere.windowStart.toISOString()).toBe(secondWhere.windowStart.toISOString());
  });
});
