// @vitest-environment node
// Unit tests for src/lib/business/weekly-risk-digest.ts:
//   - startOfUtcWeek: Monday-floor across DST boundaries (UTC is
//     DST-immune but verify the boundary math stays stable).
//   - summariseWeekOverWeek: pure selector — feed it hard-coded alert
//     slices and assert the derived {alertCount, openCount, ackCount,
//     topHotspots, topMovers, topCriticals} shape.
//   - shouldFireThisWeek: idempotency gate. 'manual' always fires;
//     'cron' skips iff (workspaceId, weekStart, triggeredBy='cron')
//     already exists.

import { describe, expect, it, vi } from 'vitest';

// The business lib's top-level imports (server-only, prisma client,
// email transport, LLM client) need to be stubbed so vitest can load
// the module. We exercise only the PURE helpers here — startOfUtcWeek,
// window7d, summariseWeekOverWeek, shouldFireThisWeek — so stubbing
// the rest is fine.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/email/from', () => ({ fromFor: () => '' }));
vi.mock('@/lib/email/send', () => ({ sendEmail: () => Promise.resolve({ id: '' }) }));
vi.mock('@/lib/email/templates', () => ({
  weeklyRiskDigestEmail: () => ({ subject: '', html: '', text: '' }),
}));
vi.mock('@/lib/ai/client', () => ({
  generateObject: () => Promise.resolve({}),
}));

import {
  shouldFireThisWeek,
  startOfUtcWeek,
  summariseWeekOverWeek,
  window7d,
} from '@/lib/business/weekly-risk-digest';

interface DigestAlertFixture {
  id: string;
  teamId: string;
  severity: string | null;
  createdAt: Date;
  acknowledgedAt: Date | null;
  finding: { cveId: string; asset: { host: string; port: number } };
}

interface DigestTrendFixture {
  signal: unknown;
  computedAt: Date;
  windowEnd: Date;
}

function alert(
  cveId: string,
  host: string,
  port: number,
  opts: { acknowledged?: boolean; severity?: string; weeksAgo?: number } = {},
): DigestAlertFixture {
  const weeksAgo = opts.weeksAgo ?? 0;
  const createdAt = new Date(Date.UTC(2025, 5, 9, 0, 0, 0) - weeksAgo * 7 * 86_400_000);
  return {
    id: `a-${cveId}-${host}-${port}-${weeksAgo}`,
    teamId: 't-1',
    severity: opts.severity ?? 'high',
    createdAt,
    acknowledgedAt: opts.acknowledged ? new Date(createdAt.getTime() + 3_600_000) : null,
    finding: { cveId, asset: { host, port } },
  };
}

describe('startOfUtcWeek', () => {
  it('floors Monday 00:00 UTC when now is Monday morning UTC', () => {
    const now = new Date(Date.UTC(2025, 5, 9, 6, 42, 17)); // Mon Jun 9 06:42:17 UTC
    const wk = startOfUtcWeek(now);
    expect(wk.toISOString()).toBe('2025-06-09T00:00:00.000Z');
  });

  it('floors the prior Monday when now is mid-week UTC', () => {
    const now = new Date(Date.UTC(2025, 5, 11, 23, 59, 59)); // Wed Jun 11 23:59:59 UTC
    const wk = startOfUtcWeek(now);
    expect(wk.toISOString()).toBe('2025-06-09T00:00:00.000Z');
  });

  it('floors the prior Monday when now is Sunday late UTC', () => {
    const now = new Date(Date.UTC(2025, 5, 15, 22, 0, 0)); // Sun Jun 15 22:00 UTC
    const wk = startOfUtcWeek(now);
    expect(wk.toISOString()).toBe('2025-06-09T00:00:00.000Z');
  });

  it('produces the same weekStart for any moment inside the same ISO week', () => {
    const mon = new Date(Date.UTC(2025, 5, 9, 0, 0, 0));
    const sun = new Date(Date.UTC(2025, 5, 15, 23, 59, 59));
    expect(startOfUtcWeek(mon).toISOString()).toBe(startOfUtcWeek(sun).toISOString());
  });

  it('keeps the floor across the spring UTC-equivalent boundary', () => {
    // DST doesn't apply in UTC, but verify the floor math stays stable
    // across the spring-forward boundary the rest of the app uses.
    const before = new Date(Date.UTC(2025, 2, 28, 23, 0, 0));
    const after = new Date(Date.UTC(2025, 2, 31, 1, 0, 0)); // Mon Mar 31
    const wkBefore = startOfUtcWeek(before);
    const wkAfter = startOfUtcWeek(after);
    expect(wkBefore.toISOString()).toBe('2025-03-24T00:00:00.000Z'); // Mon Mar 24
    expect(wkAfter.toISOString()).toBe('2025-03-31T00:00:00.000Z');
  });
});

describe('summariseWeekOverWeek', () => {
  const now = new Date(Date.UTC(2025, 5, 9, 0, 0, 0)); // Mon Jun 9

  it('returns zero counts when both windows are empty', () => {
    const out = summariseWeekOverWeek([], [], null, now);
    expect(out.alertCount).toBe(0);
    expect(out.openCount).toBe(0);
    expect(out.ackCount).toBe(0);
    expect(out.velocity).toBe(0);
    expect(out.topHotspots).toEqual([]);
    expect(out.topMovers).toEqual([]);
    expect(out.topCriticals).toEqual([]);
    expect(out.trendVelocity).toBeNull();
  });

  it('counts un-ack vs acked alerts in the recent window only', () => {
    const recent = [
      alert('CVE-1', 'a.example', 80, { acknowledged: false, severity: 'critical' }),
      alert('CVE-2', 'b.example', 443, { acknowledged: true, severity: 'high' }),
    ];
    const prior = [alert('CVE-1', 'a.example', 80, { severity: 'high', weeksAgo: 1 })];
    const out = summariseWeekOverWeek(recent, prior, null, now);
    expect(out.alertCount).toBe(2);
    expect(out.openCount).toBe(1);
    expect(out.ackCount).toBe(1);
    expect(out.velocity).toBe(1); // 2 - 1
  });

  it('ranks hotspots by count desc with stable (host, port) tiebreaks', () => {
    const recent = [
      alert('CVE-1', 'a.example', 80),
      alert('CVE-2', 'a.example', 80),
      alert('CVE-3', 'a.example', 443),
      alert('CVE-4', 'b.example', 80),
    ];
    const out = summariseWeekOverWeek(recent, [], null, now);
    expect(out.topHotspots).toEqual([
      { host: 'a.example', port: 80, count: 2 },
      { host: 'a.example', port: 443, count: 1 },
      { host: 'b.example', port: 80, count: 1 },
    ]);
  });

  it('orders topMovers by absolute delta desc and caps at MOVERS_LIMIT', () => {
    // 12 movers so the cap (10) engages.
    const recent = Array.from({ length: 12 }, (_, i) =>
      alert(`CVE-${1000 + i}`, 'h', 80, { weeksAgo: 0 }),
    );
    const prior = Array.from({ length: 12 }, (_, i) =>
      alert(`CVE-${1000 + i}`, 'h', 80, { weeksAgo: 1 }),
    );
    // Bump a few so their deltas differ.
    prior.push(alert('CVE-1000', 'h', 80, { weeksAgo: 1 }));
    prior.push(alert('CVE-1001', 'h', 80, { weeksAgo: 1 }));
    const out = summariseWeekOverWeek(recent, prior, null, now);
    expect(out.topMovers.length).toBeLessThanOrEqual(10);
    for (let i = 1; i < out.topMovers.length; i += 1) {
      expect(Math.abs(out.topMovers[i - 1].delta)).toBeGreaterThanOrEqual(
        Math.abs(out.topMovers[i].delta),
      );
    }
    expect(out.topMovers[0].cveId).toBe('CVE-1000'); // biggest |delta|
  });

  it('lists un-ack critical alerts as topCriticals and dedupes by (cveId, host)', () => {
    const recent = [
      alert('CVE-A', 'a.example', 80, { acknowledged: false, severity: 'critical' }),
      alert('CVE-A', 'a.example', 80, { acknowledged: false, severity: 'critical' }),
      alert('CVE-B', 'b.example', 443, { acknowledged: true, severity: 'critical' }),
      alert('CVE-C', 'c.example', 22, { acknowledged: false, severity: 'high' }),
    ];
    const out = summariseWeekOverWeek(recent, [], null, now);
    expect(out.topCriticals).toEqual([{ cveId: 'CVE-A', host: 'a.example' }]);
  });

  it('reads trendVelocity from the latest VulnerabilityTrend row', () => {
    const recent = [alert('CVE-X', 'h', 80)];
    const trend: DigestTrendFixture = {
      signal: { velocity: 7 },
      computedAt: new Date(),
      windowEnd: new Date(),
    };
    const out = summariseWeekOverWeek(recent, [], trend, now);
    expect(out.trendVelocity).toBe(7);
  });

  it('falls back to trendVelocity=null when the row is missing or malformed', () => {
    const malformed: DigestTrendFixture = {
      signal: { /* no velocity */ hotspots: [] },
      computedAt: new Date(),
      windowEnd: new Date(),
    };
    const out = summariseWeekOverWeek([], [], malformed, now);
    expect(out.trendVelocity).toBeNull();
  });
});

describe('shouldFireThisWeek', () => {
  const weekStart = new Date(Date.UTC(2025, 5, 9, 0, 0, 0));

  it('fires on manual trigger even if a prior row exists for the same week', () => {
    const last = { id: 'r1', triggeredBy: 'manual', weekStart };
    expect(shouldFireThisWeek(last, weekStart, 'manual')).toBe(true);
  });

  it('fires on manual trigger when no row exists for the same week', () => {
    expect(shouldFireThisWeek(null, weekStart, 'manual')).toBe(true);
  });

  it('skips cron when a same-week cron row exists', () => {
    const last = { id: 'r1', triggeredBy: 'cron', weekStart };
    expect(shouldFireThisWeek(last, weekStart, 'cron')).toBe(false);
  });

  it('fires cron when no row exists yet', () => {
    expect(shouldFireThisWeek(null, weekStart, 'cron')).toBe(true);
  });

  it('fires cron when the prior row is for a different week', () => {
    const last = {
      id: 'r1',
      triggeredBy: 'cron',
      weekStart: new Date(Date.UTC(2025, 5, 2, 0, 0, 0)), // prior Mon Jun 2
    };
    expect(shouldFireThisWeek(last, weekStart, 'cron')).toBe(true);
  });

  it('fires cron when the prior row is for the same week but a manual insert', () => {
    // A same-week manual row from an admin re-trigger does NOT
    // collapse the next Monday's cron tick — the dedupe key is
    // (workspaceId, weekStart, triggeredBy) and triggeredBy differs.
    const last = { id: 'r1', triggeredBy: 'manual', weekStart };
    expect(shouldFireThisWeek(last, weekStart, 'cron')).toBe(true);
  });
});

describe('window7d', () => {
  it('returns a 7-day window ending at now', () => {
    const now = new Date(Date.UTC(2025, 5, 9, 12, 0, 0));
    const w = window7d(now);
    expect(w.windowEnd.toISOString()).toBe(now.toISOString());
    expect(w.windowStart.toISOString()).toBe(
      new Date(Date.UTC(2025, 5, 2, 12, 0, 0)).toISOString(),
    );
  });
});
