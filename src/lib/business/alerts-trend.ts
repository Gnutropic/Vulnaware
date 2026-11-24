// @polsia:user-owned — server lib that backs jobs/alerts-trend.ts. Exports a
// pure selector (`computeWorkspaceTrend`) and a batched writer
// (`recordWorkspaceTrends`) so the cron stays small AND the selector is
// unit-testable without running the whole pipeline.
//
// Selection rule (last 30d vs the prior 30d):
//   - For each Team (one row per workspace), two batched Alert.findMany
//     reads scoped by (teamId, createdAt):
//     1. recentCount = Alert rows where createdAt >= now - 30d
//     2. priorCount  = Alert rows where now - 60d <= createdAt < now - 30d
//     Each row carries the joined VulnerabilityFinding → Asset so we can
//     derive `host:port` for the hot-spot ranking.
//   - velocity = recentCount - priorCount (positive = more alerts than
//     the prior period, negative = fewer).
//   - acceleratingDeclines = list of CVE ids whose prior-30d count was
//     > 0 AND whose recent-30d count is 0 (CVE traffic that stopped
//     showing up after being active in the prior window). Sorted by
//     prior-30d count desc so the loudest declines surface first; capped
//     at 25 ids so the wire shape stays trim.
//   - acceleratingIncreases = list of CVE ids whose recent-30d count is
//     strictly greater than the prior-30d count and > 0 in the recent
//     window (CVE traffic the team is seeing MORE of right now). Sorted
//     by (recent - prior) desc, then cveId asc as a stable tie-break;
//     capped at 25 ids. Drives the "Trending" badge on /alerts rows and
//     the per-CVE deep link at /alerts/trend/[cveId].
//   - hotspots = top-N recent `host:port` combinations by alert count,
//     `host:port` keyed at the join layer so two appearances on the same
//     host over different ports are distinct buckets. N = 5 (top 5).
//
// Idempotency:
//   - `recordWorkspaceTrends` upserts one VulnerabilityTrend row per
//     (workspaceId, windowStart). windowStart is `now - 30d` truncated to
//     UTC midnight so re-runs within the same UTC day collapse to one row
//     via the composite unique key `workspaceId_windowStart`.
//   - writer iterates teams one at a time inside a per-team try/catch
//     (mirror src/lib/business/alerts-digest.ts) so one bad team does
//     NOT abort the rest of the batch.
//
// Access posture: server-only, no per-user gate — the cron runs
// server-side unauthenticated and walks every Team.

import 'server-only';
import { prisma } from '@/lib/db';

const THIRTY_DAYS_MS = 30 * 86_400_000;
const SIXTY_DAYS_MS = 60 * 86_400_000;
const HOTSPOTS_LIMIT = 5;
const ACCELERATING_DECLINES_LIMIT = 25;
const ACCELERATING_INCREASES_LIMIT = 25;

export interface VelocityTrendHotspot {
  host: string;
  port: number;
  count: number;
}

export interface VelocityTrendSignal {
  velocity: number;
  acceleratingDeclines: string[];
  acceleratingIncreases: string[];
  hotspots: VelocityTrendHotspot[];
}

export interface ComputeTrendsResult {
  written: number;
  failed: number;
}

interface RawAlertForTrendWindow {
  id: string;
  createdAt: Date;
  finding: { cveId: string; asset: { host: string; port: number } };
}

// `windowOf` returns the recent 30-day window. `priorWindow` returns the
// 30 days BEFORE that. Both are pure date math derived from `now` so
// tests can pin deterministically.
export function windowOf(now: Date): { windowStart: Date; windowEnd: Date } {
  return { windowStart: new Date(now.getTime() - THIRTY_DAYS_MS), windowEnd: now };
}

export function priorWindow(now: Date): { windowStart: Date; windowEnd: Date } {
  const end = new Date(now.getTime() - THIRTY_DAYS_MS);
  const start = new Date(now.getTime() - SIXTY_DAYS_MS);
  return { windowStart: start, windowEnd: end };
}

// Compute the trend signal for a single workspace. Pure (no writes) so
// the unit tests exercise the selector in isolation. Reads only.
//
// `teamId` is the workspace identifier; on this app `teamId === workspaceId`
// per the per-team read posture in src/lib/team-auth.ts.
export async function computeWorkspaceTrend(
  teamId: string,
  now: Date,
): Promise<VelocityTrendSignal> {
  const recent = windowOf(now);
  const prior = priorWindow(now);

  const [recentAlerts, priorAlerts] = await Promise.all([
    prisma.alert.findMany({
      where: {
        teamId,
        createdAt: { gte: recent.windowStart, lt: recent.windowEnd },
      },
      select: {
        id: true,
        createdAt: true,
        finding: { select: { cveId: true, asset: { select: { host: true, port: true } } } },
      },
    }),
    prisma.alert.findMany({
      where: {
        teamId,
        createdAt: { gte: prior.windowStart, lt: prior.windowEnd },
      },
      select: {
        id: true,
        createdAt: true,
        finding: { select: { cveId: true, asset: { select: { host: true, port: true } } } },
      },
    }),
  ]);

  return summarizeAlerts(recentAlerts, priorAlerts);
}

// Pure derivation — exposed for unit tests so they can pin the algorithm
// without spinning up prisma.
//
// acceleratingDeclines = CVEs whose prior count > 0 AND whose recent
// count is 0. Sorted by prior count desc, capped at 25 ids.
// acceleratingIncreases = CVEs whose recent count > 0 AND recent count
// is strictly greater than prior count. Sorted by (recent - prior) desc
// then cveId asc as a stable tie-break; capped at 25 ids. A CVE that
// newly appeared in the recent window (prior = 0, recent > 0) qualifies.
// A CVE that was flat (recent === prior) does NOT qualify.
export function summarizeAlerts(
  recentAlerts: RawAlertForTrendWindow[] | null | undefined,
  priorAlerts: RawAlertForTrendWindow[] | null | undefined,
): VelocityTrendSignal {
  const recent = Array.isArray(recentAlerts) ? recentAlerts : [];
  const prior = Array.isArray(priorAlerts) ? priorAlerts : [];

  const velocity = recent.length - prior.length;

  const recentHotspots = new Map<string, VelocityTrendHotspot>();
  for (const a of recent) {
    const host = a.finding.asset.host;
    const port = a.finding.asset.port;
    const key = `${host}:${port}`;
    const existing = recentHotspots.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      recentHotspots.set(key, { host, port, count: 1 });
    }
  }
  const hotspots = Array.from(recentHotspots.values())
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      // Tie-break: stable alpha on (host, port) so a re-derive is
      // byte-identical across cron runs. The wire reader does not depend
      // on this ordering but the trend timeline benefits from stable
      // compares between day-over-day signals.
      if (a.host !== b.host) return a.host < b.host ? -1 : 1;
      return a.port - b.port;
    })
    .slice(0, HOTSPOTS_LIMIT);

  const recentCveCounts = new Map<string, number>();
  for (const a of recent) {
    const cve = a.finding.cveId;
    recentCveCounts.set(cve, (recentCveCounts.get(cve) ?? 0) + 1);
  }
  const priorCveCounts = new Map<string, number>();
  for (const a of prior) {
    const cve = a.finding.cveId;
    priorCveCounts.set(cve, (priorCveCounts.get(cve) ?? 0) + 1);
  }

  const acceleratingDeclines: string[] = [];
  for (const [cve, priorCount] of priorCveCounts) {
    if (priorCount > 0 && (recentCveCounts.get(cve) ?? 0) === 0) {
      acceleratingDeclines.push(cve);
    }
  }
  acceleratingDeclines.sort((a, b) => {
    const bCount = priorCveCounts.get(b) ?? 0;
    const aCount = priorCveCounts.get(a) ?? 0;
    if (bCount !== aCount) return bCount - aCount;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  if (acceleratingDeclines.length > ACCELERATING_DECLINES_LIMIT) {
    acceleratingDeclines.length = ACCELERATING_DECLINES_LIMIT;
  }

  const acceleratingIncreases: string[] = [];
  for (const [cve, recentCount] of recentCveCounts) {
    const priorCount = priorCveCounts.get(cve) ?? 0;
    if (recentCount > 0 && recentCount > priorCount) {
      acceleratingIncreases.push(cve);
    }
  }
  acceleratingIncreases.sort((a, b) => {
    const aRecent = recentCveCounts.get(a) ?? 0;
    const aPrior = priorCveCounts.get(a) ?? 0;
    const bRecent = recentCveCounts.get(b) ?? 0;
    const bPrior = priorCveCounts.get(b) ?? 0;
    const aDelta = aRecent - aPrior;
    const bDelta = bRecent - bPrior;
    if (bDelta !== aDelta) return bDelta - aDelta;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  if (acceleratingIncreases.length > ACCELERATING_INCREASES_LIMIT) {
    acceleratingIncreases.length = ACCELERATING_INCREASES_LIMIT;
  }

  return { velocity, acceleratingDeclines, acceleratingIncreases, hotspots };
}

// Compute + write one VulnerabilityTrend row per Team. Idempotent: a
// re-run within the same UTC day collapses to one row via the composite
// unique key `workspaceId_windowStart` declared on the model.
//
// Returns counts so the cron can emit a useful breadcrumb. Per-team
// errors are counted but never propagated so one bad team does not abort
// the rest of the batch.
export async function recordWorkspaceTrends(now: Date): Promise<ComputeTrendsResult> {
  const teams = await prisma.team.findMany({ select: { id: true } });
  if (teams.length === 0) return { written: 0, failed: 0 };

  const recent = windowOf(now);
  // Truncate windowStart to UTC midnight so the composite upsert key is
  // stable across same-day re-runs. windowEnd is `now` (NOT truncated)
  // so writers can see the trend is fresh.
  const windowStart = new Date(
    Date.UTC(
      recent.windowStart.getUTCFullYear(),
      recent.windowStart.getUTCMonth(),
      recent.windowStart.getUTCDate(),
    ),
  );
  const windowEnd = now;

  let written = 0;
  let failed = 0;

  for (const team of teams) {
    try {
      const signal = await computeWorkspaceTrend(team.id, now);
      // JSON round-trip strips index signatures so Prisma's InputJsonValue
      // accepts the payload without a structural mismatch.
      const signalJson = JSON.parse(JSON.stringify(signal)) as object;
      await prisma.vulnerabilityTrend.upsert({
        where: {
          workspaceId_windowStart: {
            workspaceId: team.id,
            windowStart,
          },
        },
        create: {
          workspaceId: team.id,
          windowStart,
          windowEnd,
          signal: signalJson,
          computedAt: now,
        },
        update: {
          signal: signalJson,
          windowEnd,
          computedAt: now,
        },
      });
      written += 1;
    } catch (_err) {
      failed += 1;
    }
  }

  return { written, failed };
}

export const _constants = {
  THIRTY_DAYS_MS,
  SIXTY_DAYS_MS,
  HOTSPOTS_LIMIT,
  ACCELERATING_DECLINES_LIMIT,
  ACCELERATING_INCREASES_LIMIT,
};
