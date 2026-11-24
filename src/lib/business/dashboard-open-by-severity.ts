// @polsia:user-owned — `loadOpenAlertCountsBySeverity(teamId, now)`
// for GET /api/dashboard/open-by-severity. Server-only: imports
// `server-only` + `prisma`. The route layer
// (src/app/api/dashboard/open-by-severity) is the ONLY caller;
// never called from a Server Component, page body, or layout
// (data-plane rule).
//
// Tile predicate (matches the brief):
//   - `status: 'open'` (literal)              → @@index([teamId, status])
//   - `remediatedAt: null`                   → @@index([teamId, remediatedAt])
//   - OR[{ snoozedUntil: null }, { snoozedUntil: { lte: now } }]
//                                             → @@index([teamId, snoozedUntil])
// All three predicates hit existing composite indexes; the
// OR-branch rides the composite (teamId, snoozedUntil) so a row
// the operator has snoozed into the future never contributes to
// the visibility of this tile (mirror of the /api/alerts default
// hide-snoozed posture so the tile count and the click-through
// chip agree on "silenced rows are invisible").
//
// One Prisma `groupBy({ by: ['severity'], where, _count: true })`
// round-trip — narrower than four independent `count` calls because
// the groupBy path already returns the per-severity buckets in one
// indexed scan over the team's `status='open'` rows. The result is
// coalesced to the four canonical literals (critical|high|medium|low);
// `Alert.severity` is free-form text on disk so any unknown / null
// groupBy key collapses to 'low' — same posture as the /api/alerts
// chip-row coalescer at src/app/api/alerts/route.ts (critical|high|
// medium|low coalescence, unknown → low) so a legacy row never
// produces an empty bucket key.
//
// `now` is injectable to keep the selector pure for tests; callers
// from route handlers rely on the default `new Date()`.

import 'server-only';
import { prisma } from '@/lib/db';

export interface OpenAlertCountsBySeverity {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

// Canonical wire-order for the four severity buckets. Mirrors
// `SEVERITY_RANK` in src/lib/business/alerts-severity.ts so the
// tile's emitted order matches the chip-row's emitted order and a
// permalink from a chip lands on /alerts with the matching severity
// chip already active.
type SeverityKey = keyof OpenAlertCountsBySeverity;

function coalesceSeverity(rowSeverity: string | null): SeverityKey {
  const normalized = (rowSeverity ?? '').toLowerCase();
  if (normalized === 'critical' || normalized === 'high' || normalized === 'medium') {
    return normalized;
  }
  // Unknown / null / empty / 'low' / anything else → 'low'. Matches
  // /api/alerts's chip-row posture so the two surfaces never disagree
  // about where a legacy row belongs.
  return 'low';
}

export async function loadOpenAlertCountsBySeverity(
  teamId: string,
  now: Date = new Date(),
): Promise<OpenAlertCountsBySeverity> {
  // Single indexed groupBy scan over the team's currently-open,
  // non-snoozed, non-remediated rows. Coalesce the free-form
  // `severity` text on the row to the four canonical literals and
  // roll up the per-key counts into the wire envelope. Any key
  // absent from the result set defaults to 0 via the initial
  // zero-fill below.
  const groups = await prisma.alert.groupBy({
    by: ['severity'],
    where: {
      teamId,
      status: 'open',
      remediatedAt: null,
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
    },
    _count: true,
  });

  const counts: OpenAlertCountsBySeverity = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };

  for (const group of groups) {
    const key = coalesceSeverity(group.severity);
    counts[key] += group._count;
  }

  // Return shape wire-matched to `DashboardOpenBySeverityCounts` so
  // the route can `DashboardOpenBySeverityCounts.parse(...)` it
  // directly. The keys are guaranteed-flat across all four
  // canonical literals — an unknown / null severity column never
  // produces an off-envelope key because coalesceSeverity folds
  // everything into 'low'.
  return counts;
}
