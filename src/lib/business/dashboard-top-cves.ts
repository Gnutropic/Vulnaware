// @polsia:user-owned — `loadDashboardTopCves(teamId, now)` for GET
// /api/dashboard/top-cves. Server-only: imports `server-only` +
// `prisma`. The route layer (src/app/api/dashboard/top-cves) is the
// ONLY caller; never called from a Server Component, page body, or
// layout (data-plane rule).
//
// Strategy: ONE `prisma.alert.findMany` that ORs the recently-
// resolved arm (now widened to either-column closure semantics)
// AND the open arm — keeping the load to a single round trip. We
// cannot use `prisma.alert.groupBy({ by: ['finding.cveId'] })`
// because grouped relation columns are not accepted as `by` keys,
// so the bucketed reduce happens in app code (mirror of
// `dashboard-top-assets.ts`:102-118's posture).
//
// Filter shape:
//   - `teamId`                              — server-seeded from
//                                              `workspaceContext.workspaceId`
//                                              so the tile is scoped
//                                              to the caller's team on
//                                              every read.
//   - `OR` (three arms, mirrored disposition so a row that flipped
//                    closed AND remediated cannot double-count):
//       1. OPEN arm: `status: 'open' AND remediatedAt: null AND
//          OR[{ snoozedUntil: null }, { snoozedUntil: { lte: now } }]`.
//          Mirror of /api/alerts's hide-snoozed default + the
//          /api/dashboard/open-by-severity loader — a silenced
//          (`snoozedUntil > now`) row is operator-muted across the
//          app so it never contributes to a "recurring" ranking. The
//          `remediatedAt: null` predicate pairs with `status: 'open'`
//          so a remediated-but-still-status=open row (a stale
//          intermediate state) does NOT contribute to the open side —
//          it would otherwise double-count with the recently-
//          remediated side.
//       2. RECENTLY REMEDIATED arm: `remediatedAt: { not: null,
//          gte: sevenDaysAgo }`. A 7-day window chosen so a CVE that
//          surfaced twice this week is "recurring"; the brief's
//          phrase "open and recently remediated" anchors to the
//          existing 7-day mental model (matching
//          `DashboardRecentActivity`'s 7-day window and
//          `DashboardSummary.resolvedThisWeek`'s 7-day window)
//          rather than picking an arbitrary new edge.
//       3. RECENTLY RESOLVED-WITHOUT-REMEDIATE arm: `remediatedAt:
//          null AND closedAt: { not: null, gte: sevenDaysAgo }`. NEW
//          widening: a resolve stamp without a corresponding
//          remediate stamp is now included in the recurring tally
//          so a CVE that the team just-closes (without bothering to
//          stamp `Mark as remediated`) still surfaces as a recent
//          recurrent concern. Pairs `remediatedAt: null` with
//          `closedAt: { not: null }` so a row stamped in BOTH
//          columns is picked up by the remediated-At arm ONLY
//          (which counts it as a recent remediation) — the
//          never-remediated + recently-closed arm is the gap-filler
//          that keeps a "Mark as resolved"-only row visible.
//
// Narrow select (`severity` + nested `finding.cveId`) keeps the
// wire move cheap. No `take` cap — the OR-clause is naturally
// bounded by the indexed predicates + the snooze-exclusion branch,
// and a team-wide scan of two narrow columns is bounded by row-set
// breadth, not by row count. Trades completeness for a single
// round-trip read.
//
// Severity + dominant per CVE:
//   - `Alert.severity` free-form text column. The reduce coalesces
//     it to the four canonical literals (critical|high|medium|low);
//     unknown / null collapses to 'low' (mirror of
//     `dashboard-open-by-severity.ts`:51-60 and
//     `dashboard-top-assets.ts`:62-78).
//   - `count(cveId)`              — unweighted; every contributing
//                                    row counts 1 regardless of tier.
//   - `mix[cveId][tier]`          — bucket counter for sub-mix
//                                    rendering ("n critical · n
//                                    high · …").
//   - `dominantSeverity(cveId)`   — highest ordinal tier that has a
//                                    positive count in the mix
//                                    (`null` only when no tier
//                                    contributed, which by
//                                    construction can't happen).
//
// Skip posture:
//   - A row with a missing / empty `finding.cveId` is dropped from
//     the reduce so the cveId-keyed Map never sees an undefined key.
//     Mirror of `dashboard-top-assets.ts`:124-127 (skip rows with
//     missing / empty host). A manual alert's synthetic placeholder
//     finding is unrelated to a real CVE identifier, so it naturally
//     surfaces as an empty string and is dropped — the tile is
//     strictly a CVE-ranked view.
//
// Sort + slice: `count` desc → `cveId` asc (stable alpha tiebreak;
// matches `dashboard-top-assets.ts`'s posture). Slice to top 5
// server-side, `.max(5)` on `DashboardTopCves.items` fails the parse
// loudly on any server drift above the cap.

import 'server-only';
import { prisma } from '@/lib/db';

const TOP_N = 5;
const RECENT_REMEDIATED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface DashboardTopCveItemRow {
  cveId: string;
  count: number;
  dominantSeverity: 'critical' | 'high' | 'medium' | 'low' | null;
  mix: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
}

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

function coalesceSeverity(rowSeverity: string | null): 'critical' | 'high' | 'medium' | 'low' {
  const normalized = (rowSeverity ?? '').toLowerCase();
  if (normalized === 'critical' || normalized === 'high' || normalized === 'medium') {
    return normalized;
  }
  // Unknown / null / empty / 'low' / anything else → 'low'. Matches
  // /api/alerts's chip-row posture so the rally between tile and
  // chip row is always internally consistent.
  return 'low';
}

interface CveAccumulator {
  cveId: string;
  count: number;
  bestOrdinal: number;
  mix: { critical: number; high: number; medium: number; low: number };
}

export async function loadDashboardTopCves(
  teamId: string,
  now: Date = new Date(),
): Promise<{ items: DashboardTopCveItemRow[] }> {
  const sevenDaysAgo = new Date(now.getTime() - RECENT_REMEDIATED_WINDOW_MS);

  const rows = await prisma.alert.findMany({
    where: {
      teamId,
      OR: [
        // Open scope: hide-snoozed + remediatedAt IS NULL so a
        // stale status='open' AND remediatedAt NOT NULL row does
        // NOT count on the open side (would otherwise double-count
        // with the recently-remediated arm).
        {
          status: 'open',
          remediatedAt: null,
          OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
        },
        // Recently remediated scope: 7-day window. The
        // `remediatedAt: { not: null }` clause pairs with `gte` so
        // a missing remediatedAt does not pass the lower bound
        // accidentally. No status / snooze filter — a row can be
        // remediated regardless of its post-remediation status
        // (resolved / false_positive).
        {
          remediatedAt: { not: null, gte: sevenDaysAgo },
        },
        // Recently resolved-without-remediate arm: 7-day window on
        // `closedAt` paired with `remediatedAt: null` so a row that
        // has BOTH stamps is NOT double-counted via UNION'ing the
        // two arms — the row would already have hit the remediated-
        // At arm above. Surfaces rows the team closed via "Mark as
        // resolved" without ever flipping the remediate stamp.
        {
          remediatedAt: null,
          closedAt: { not: null, gte: sevenDaysAgo },
        },
      ],
    },
    select: {
      severity: true,
      // cveId is on `VulnerabilityFinding`, NOT a column on `Alert`
      // directly. Selecting it through the relation keeps the
      // join-breadth down to a single string column.
      finding: { select: { cveId: true } },
    },
  });

  // In-app reduce — group raw rows by cveId, accumulating count +
  // per-tier mix + tracking the highest ordinal tier so we can
  // derive the dominant severity badge. Manual rows fall out
  // naturally because their `finding.cveId` is empty.
  const byCve = new Map<string, CveAccumulator>();
  for (const row of rows) {
    const cveId = row.finding?.cveId;
    if (typeof cveId !== 'string' || cveId.length === 0) continue;
    const tier = coalesceSeverity(row.severity);
    const ordinal = SEVERITY_ORDINAL[tier] ?? 0;
    const existing = byCve.get(cveId);
    if (existing) {
      existing.count += 1;
      existing.mix[tier] += 1;
      if (ordinal > existing.bestOrdinal) existing.bestOrdinal = ordinal;
    } else {
      const initialMix = { critical: 0, high: 0, medium: 0, low: 0 };
      initialMix[tier] = 1;
      byCve.set(cveId, {
        cveId,
        count: 1,
        bestOrdinal: ordinal,
        mix: initialMix,
      });
    }
  }

  // Sort: count desc → cveId asc (stable alpha tiebreak; mirror of
  // `dashboard-top-assets.ts`:148-153). Slice to top 5.
  const ranked = Array.from(byCve.values())
    .map((acc) => ({
      cveId: acc.cveId,
      count: acc.count,
      dominantSeverity: ORDINAL_TO_LITERAL[acc.bestOrdinal] ?? null,
      mix: acc.mix,
    }))
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      return a.cveId.localeCompare(b.cveId);
    })
    .slice(0, TOP_N);

  return { items: ranked };
}
