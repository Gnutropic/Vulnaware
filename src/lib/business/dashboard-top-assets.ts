// @polsia:user-owned — `loadDashboardTopAssets(teamId, hardCap)` for GET
// /api/dashboard/top-assets. Server-only: imports `server-only` +
// `prisma`. The route layer (src/app/api/dashboard/top-assets) is
// the ONLY caller; never called from a Server Component, page body,
// or layout (data-plane rule).
//
// Strategy: ONE `prisma.alert.findMany` that reads every OPEN alert
// for the caller's team joined to `finding → asset.host`, then
// reduces in-app by host. We cannot use Prisma `groupBy({ by:
// ['finding.asset.host'] })` because relation columns are not
// accepted as `by` keys (mirror of asset-options route's posture at
// `src/app/api/alerts/asset-options/route.ts:78-110`).
//
// Filter shape:
//   - `teamId`              — server-seeded from `workspaceContext.workspaceId`
//                             so the tile is scoped to the caller's
//                             team on every read.
//   - "open" predicate      — any row whose status is neither
//                             `resolved` nor `false_positive` AND whose
//                             snooze window is NOT currently active
//                             (`snoozedUntil IS NULL OR snoozedUntil <=
//                             now`). `in_progress` rows count here
//                             (operator has acknowledged but not
//                             remediated), and a row whose `open`
//                             status is paired with an active snooze
//                             is suppressed — the operator has
//                             explicitly silenced it for the snooze
//                             window, so it shouldn't surface on the
//                             "open" tile until the snooze elapses.
//   - `findingId: { not: 'manual' }` — strips manual-source rows so
//                             the host-keyed reduce never sees an
//                             undefined host (a manual alert has no
//                             underlying Asset row).
//
// Narrow select (`severity` + nested `finding.asset.host`) plus a
// bounded `take: hardCap` (mirrors the trend selector's cap
// discipline — `hardCap = 5000` default) trades completeness for a
// bounded wire move: a team with runaway volume in the open window
// silently truncates and the tile's top-5 ranking reflects the
// truncated, not the true, severity-weighted distribution.
//
// Score + dominant severity:
//   - `score(host)` = Σ severityOrdinal(sev) over every open
//                     alert at that host. Ordinal map lowercases
//                     the free-form
//                     `Alert.severity` string and falls back to 0
//                     on a null / unknown value so a row with an
//                     unknown severity still counts (count = 1)
//                     but contributes 0 to the score.
//   - `dominantSeverity` = highest ordinal-tier present at that
//                     host (`null` when no severity-bearing rows
//                     survived, which is essentially never in
//                     practice but matches the `.nullable()` on
//                     `DashboardTopAssetItem`).
//
// Sort: `count` desc → `host` asc. `score` is dropped from the rank
// key so a critical-heavy-but-low-volume host cannot outrank a
// high-volume low-severity host — the brief is unweighted count
// only. `score` stays stamped on the wire for parity with the rest
// of the dashboard family (and for the order-flip backstop if a
// future brief re-weights). `host` asc is the alpha tiebreak so two
// equal-count hosts surface in a stable, alphabetical order (matches
// the asset-options route's alpha tiebreak posture).
//
// Slice to the top 10 server-side.

import 'server-only';
import { prisma } from '@/lib/db';

const DEFAULT_HARD_CAP = 5000;
const TOP_N = 10;

const SEVERITY_ORDINAL: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

// Reverse map (ordinal → canonical lowercase label) so the
// lookup above's "highest present tier" produces the canonical
// `critical | high | medium | low` literal — `null` when no row
// contributed a known severity for that host.
const ORDINAL_TO_LITERAL: Record<number, 'critical' | 'high' | 'medium' | 'low'> = {
  4: 'critical',
  3: 'high',
  2: 'medium',
  1: 'low',
};

export interface DashboardTopAssetsItem {
  host: string;
  count: number;
  dominantSeverity: 'critical' | 'high' | 'medium' | 'low' | null;
  score: number;
}

interface HostAccumulator {
  host: string;
  count: number;
  score: number;
  // Highest ordinal tier seen at this host so far. `0` means
  // "no known severe row yet" so the early scans can replace
  // via `Math.max`.
  bestOrdinal: number;
}

export async function loadDashboardTopAssets(
  teamId: string,
  hardCap: number = DEFAULT_HARD_CAP,
): Promise<{ items: DashboardTopAssetsItem[] }> {
  const cappedTake = Math.max(1, Math.min(DEFAULT_HARD_CAP, Math.floor(hardCap)));
  const now = new Date();

  // "Open" = unresolved (status NOT IN resolved, false_positive) AND
  // not currently-snoozed-active. The OR branch on `snoozedUntil`
  // covers both "never snoozed" (column is null) and "snooze elapsed"
  // (`snoozedUntil <= now`). A row whose status is `open` but whose
  // snooze is still active is suppressed so an operator who hit
  // "Silence for 7d" never sees that row reappear on the "open"
  // tile until the snooze window elapses.
  const rows = await prisma.alert.findMany({
    where: {
      teamId,
      status: { notIn: ['resolved', 'false_positive'] },
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
      findingId: { not: 'manual' },
    },
    select: {
      severity: true,
      finding: {
        select: {
          asset: { select: { host: true } },
        },
      },
    },
    take: cappedTake,
  });

  // In-app reduce — group raw rows by host, accumulating count +
  // severity-weighted score + tracking the highest ordinal tier so
  // we can derive the dominant severity badge.
  const byHost = new Map<string, HostAccumulator>();
  for (const row of rows) {
    const host = row.finding?.asset?.host;
    if (typeof host !== 'string' || host.length === 0) continue;
    const ordinal = SEVERITY_ORDINAL[(row.severity ?? '').toLowerCase()] ?? 0;
    const existing = byHost.get(host);
    if (existing) {
      existing.count += 1;
      existing.score += ordinal;
      if (ordinal > existing.bestOrdinal) existing.bestOrdinal = ordinal;
    } else {
      byHost.set(host, { host, count: 1, score: ordinal, bestOrdinal: ordinal });
    }
  }

  // Sort: count desc → host asc (stable alpha tiebreak; `score`
  // stays on the wire for parity but is NOT a rank key here).
  // Slice to the top 10 — `.max(10)` on `DashboardTopAssets.items`
  // fails the parse loudly if the slice ever drifts above the cap.
  const ranked = Array.from(byHost.values())
    .map((acc) => ({
      host: acc.host,
      count: acc.count,
      score: acc.score,
      dominantSeverity: ORDINAL_TO_LITERAL[acc.bestOrdinal] ?? null,
    }))
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      return a.host.localeCompare(b.host);
    })
    .slice(0, TOP_N);

  return { items: ranked };
}
