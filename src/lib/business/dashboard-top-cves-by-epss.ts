// @polsia:user-owned — `loadDashboardTopCvesByEpss(teamId, now)` for
// GET /api/dashboard/top-cves-by-epss. Server-only: imports
// `server-only` + `prisma`. The route layer
// (src/app/api/dashboard/top-cves-by-epss) is the ONLY caller; never
// called from a Server Component, page body, or layout (data-plane
// rule).
//
// Strategy: ONE `prisma.alert.findMany` that reads every currently-
// open alert for the caller's team joined to
// `finding.{cveId, epssScore, severity, asset.host}`, then reduces in-
// app by cveId. `prisma.alert.groupBy({ by: ['finding.cveId'] })` is
// not possible because grouped relation columns are not accepted as
// `by` keys — so the bucketed reduce happens in app code, mirroring
// the posture of the parallel `dashboard-top-cves.ts` and
// `dashboard-top-assets.ts` selectors.
//
// Filter shape:
//   - `teamId`                            — server-seeded from
//                                            `workspaceContext.workspaceId`
//                                            so the tile is scoped to
//                                            the caller's team on every
//                                            read.
//   - `status: { in: ['open','in_progress'] }`
//                                          — "currently open"
//                                            disposition. Mirrors the
//                                            brief: not resolved AND
//                                            not false_positive. A
//                                            `manual` row whose status
//                                            is `open` would already
//                                            pass this filter — the
//                                            `findingId: { not:
//                                            'manual' }` exclusion
//                                            below is what drops it.
//   - `findingId: { not: 'manual' }`      — strips manual-source
//                                            rows; their
//                                            `finding.cveId` is a
//                                            placeholder unrelated to
//                                            a real `CVE-…` literal
//                                            and would corrupt the
//                                            per-cveId reduce if
//                                            included.
//   - `OR[{ snoozedUntil: null },
//       { snoozedUntil: { lte: now } }]`
//                                          — hide-snoozed posture
//                                            identical to /api/alerts:
//                                            a row with `snoozedUntil >
//                                            now` is operator-silenced
//                                            and does NOT contribute to
//                                            the open ranking.
//
// Narrow select (`severity` + nested
// `finding.{cveId, epssScore, severity, asset.host}`) keeps the wire
// move cheap. No `take` cap — the open-arm is naturally bounded by
// the indexed predicates + the snooze-exclusion branch, and a team-
// wide scan of four narrow columns is bounded by row-set breadth,
// not by row count.
//
// Per-CVE accumulator fields:
//   - `epssScore`  = MAX across the contributing findings' raw 0..1
//                    epss scores. Different findings on the same
//                    CVE could have slightly different EPSS scores
//                    (re-ingestion over time); MAX picks the worst-
//                    of-the-row signal which is what the operator
//                    wants surfaced for triage prioritization.
//   - `bestSeverityOrdinal` = highest severity tier present in the
//                    contributing findings (same posture as
//                    `dashboard-top-cves.ts`:110-115). `0` when no
//                    severity-bearing row contributed — by
//                    construction can't happen because every
//                    contributing finding has SOME severity column
//                    value, but kept nullable for symmetry with the
//                    other top-N selectors.
//   - `affectedAssets`     = `Set<host>` of distinct asset hosts
//                    across the contributing findings. The visible
//                    `affectedAssetCount` is the set size so re-
//                    scans of the same host do not inflate the
//                    stamp.
//
// Sort + slice: `epssScore` desc (nulls last, since a CVE that
// scores 0% is no better than no EPSS stamp at all) → severity
// ordinal desc → `cveId` asc (stable alpha tiebreak). Slice to top
// 8 server-side so the schema's `.max(8)` fails the parse loudly
// on any drift above the cap.

import 'server-only';
import { prisma } from '@/lib/db';

const TOP_N = 8;

const SEVERITY_ORDINAL: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const ORDINAL_TO_LITERAL: Record<number, 'critical' | 'high' | 'medium' | 'low'> = {
  4: 'critical',
  3: 'high',
  2: 'medium',
  1: 'low',
};

export interface DashboardTopCveByEpssItemRow {
  cveId: string;
  epssScore: number | null;
  dominantSeverity: 'critical' | 'high' | 'medium' | 'low' | null;
  affectedAssetCount: number;
}

interface CveAccumulator {
  cveId: string;
  bestEpss: number | null;
  bestSeverityOrdinal: number;
  affectedAssets: Set<string>;
}

export async function loadDashboardTopCvesByEpss(
  teamId: string,
  now: Date = new Date(),
): Promise<{ items: DashboardTopCveByEpssItemRow[] }> {
  const rows = await prisma.alert.findMany({
    where: {
      teamId,
      status: { in: ['open', 'in_progress'] },
      // findingId is a scalar FK on Alert — `not: 'manual'` matches
      // the existing posture at /api/dashboard/top-cves and the
      // asset-options route. The string is the `Alert.findingId`
      // literal stamped when a manual alert is created via
      // /api/alerts/manual.
      findingId: { not: 'manual' },
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
    },
    select: {
      severity: true,
      finding: {
        select: {
          cveId: true,
          epssScore: true,
          // The chip-row severity comes off Finding.severity (the
          // authoritative per-CVE source), NOT Alert.severity (a
          // row-level stamp that the operator can override per
          // triage). Mirrors the parallel posture of the open-by-
          // severity selector, where finding.severity is a better
          // "natural" tier than alert.severity.
          severity: true,
          asset: { select: { host: true } },
        },
      },
    },
  });

  // In-app reduce — group raw rows by cveId, accumulating the
  // worst-of-the-row EPSS score, the dominant severity tier, and
  // the distinct set of affected asset hosts. Manual rows fall out
  // naturally because their `finding.cveId` is empty (the manual
  // finding has no real CVE identifier); the `findingId: { not:
  // 'manual' }` exclusion above is a bouncer belt-and-suspenders
  // backstop.
  const byCve = new Map<string, CveAccumulator>();
  for (const row of rows) {
    const cveId = row.finding?.cveId;
    if (typeof cveId !== 'string' || cveId.length === 0) continue;

    const epss = row.finding?.epssScore;
    const severityLabel = (row.finding?.severity ?? '').toLowerCase();
    const ordinal = SEVERITY_ORDINAL[severityLabel] ?? 0;
    const host = row.finding?.asset?.host;
    // An unknown / empty host is skipped from the Set but the
    // row still contributes EPSS + severity to the cveId's
    // accumulator (the finding itself is valid; only the host
    // join is missing).
    const safeHost = typeof host === 'string' && host.length > 0 ? host : null;

    const existing = byCve.get(cveId);
    if (existing) {
      if (typeof epss === 'number' && (existing.bestEpss === null || epss > existing.bestEpss)) {
        existing.bestEpss = epss;
      }
      if (ordinal > existing.bestSeverityOrdinal) existing.bestSeverityOrdinal = ordinal;
      if (safeHost) existing.affectedAssets.add(safeHost);
    } else {
      const acc: CveAccumulator = {
        cveId,
        bestEpss: typeof epss === 'number' ? epss : null,
        bestSeverityOrdinal: ordinal,
        affectedAssets: safeHost ? new Set([safeHost]) : new Set<string>(),
      };
      byCve.set(cveId, acc);
    }
  }

  // Sort: epssScore desc (nulls last) → severity ordinal desc →
  // cveId asc (stable alpha tiebreak). Slice to top 8 — `.max(8)`
  // on `DashboardTopCvesByEpss.items` fails the parse loudly if the
  // slice ever drifts above the cap.
  const ranked = Array.from(byCve.values())
    .map((acc) => ({
      cveId: acc.cveId,
      epssScore: acc.bestEpss,
      dominantSeverity: ORDINAL_TO_LITERAL[acc.bestSeverityOrdinal] ?? null,
      affectedAssetCount: acc.affectedAssets.size,
    }))
    .sort((a, b) => {
      // Nulls last: a row with no EPSS stamp is strictly worse than
      // any row with an EPSS stamp, regardless of severity tiebreak.
      const aScore = a.epssScore ?? -1;
      const bScore = b.epssScore ?? -1;
      if (aScore !== bScore) return bScore - aScore;
      // Severity tiebreak (ordinal desc) only applies when the EPSS
      // scores are equal — including the "both null" branch where
      // the cveId-only-trailback row joins a same-null row.
      const aOrd = SEVERITY_ORDINAL[a.dominantSeverity ?? ''] ?? 0;
      const bOrd = SEVERITY_ORDINAL[b.dominantSeverity ?? ''] ?? 0;
      if (aOrd !== bOrd) return bOrd - aOrd;
      return a.cveId.localeCompare(b.cveId);
    })
    .slice(0, TOP_N);

  return { items: ranked };
}
