// @polsia:user-owned — Alert comparator mirrored by the server-side
// `orderBy` branches in /api/alerts/route.ts and
// /api/alerts/export.csv/route.ts. Pure TypeScript so a unit test can
// exercise every branch without booting Prisma, and so a future caller
// (e.g. a client-side resort of the first page once a sort flips the
// URL) imports one source of truth.
//
// Order semantics — date-based arms keep their established direction,
// while severity uses severity rank followed by one stable hostname/ID
// order in both directions:
//   - `severity` — rank `a.severity` (critical=4 > high=3 > medium=2 >
//     low=1 > unknown/null=0); ties break by hostname ascending, then
//     alert ID ascending. Both directions use the same tie order.
//   - `severity:asc` — low → medium → high → critical, with unknown or
//     null severities after the four known levels; ties use the same
//     hostname-then-ID order as descending.
//   - `status` — compare by Prisma enum ordinal (open=0 <
//     in_progress=1 < resolved=2 < false_positive=3) so ascending
//     yields open first; same tiebreak as severity.
//   - `lastActivity` — descending on the row's
//     `lastActivityAt ?? createdAt` so a row whose derivation
//     resolved to null still ranks on its creation timestamp
//     rather than sinking to the bottom. Tiebreak on createdAt
//     desc then id desc, the same shape as `severity` /
//     `status`. SQL cursor stays monotone `createdAt desc`
//     (the column Prisma can natively orderBy); the in-app
//     re-rank on the page slice keeps the visible table on
//     `lastActivity` order while skipping the cost of a
//     `$queryRaw` branch. **`lastActivity` is the default** so a
//     freshly-loaded /alerts page lazy-`useState` lands here on
//     first paint — mirror of the zod schema's resting default.
//   - `lastActivity:asc` — same rank key as `lastActivity` but
//     ASCENDED (`aAt - bAt`). Tied to the dropdown's "Last activity
//     (Oldest first)" option. Wire form on the URL is
//     `last_activity_asc` (snake_case + direction suffix), per the
//     brief-friendly writer in
//     `@/lib/business/alerts-effective-qs`.
//   - `created` — `Date.parse(b.createdAt) - Date.parse(a.createdAt)`
//     (descending createdAt). Surface "Created (most recent first)"
//     in the toolbar dropdown. Same SQL cursor as `lastActivity`
//     (Prisma-native `createdAt desc`); the in-app comparator
//     resolves to the same monotone ordering so the page
//     lazy-init and the export mirror the visible rows.
//   - `created:asc` — `createdAt` ASCENDED; tied to the dropdown's
//     "Created (Oldest first)" option. Wire form `created_asc`.

import type { AlertItem, AlertSortKey } from '@/lib/contracts/alerts';

export type { AlertSortKey } from '@/lib/contracts/alerts';

// Keep IN SYNC with src/lib/contracts/alerts.ts AlertSortKey (the
// post-transform output set: `'newest'` is mapped to `'created'` and
// `'last_activity'` is mapped to `'lastActivity'` on the schema parse
// so this manifest lives on the canonical side). Mirror here so a
// pure-TS importer (this file) can keep a controlled subset without
// dragging zod into a unit-test surface.
const ALERT_SORT_KEYS = [
  'created',
  'created:asc',
  'severity',
  'severity:asc',
  'status',
  'lastActivity',
  'lastActivity:asc',
  'riskScore',
  'riskScore:asc',
] as const;

export function isAlertSortKey(v: unknown): v is AlertSortKey {
  return typeof v === 'string' && (ALERT_SORT_KEYS as readonly string[]).includes(v);
}

// `severity` is a free-form text column on disk; old rows may carry
// null or an unrecognized literal. `lowercase + canonical-map + 0 sink`
// matches the route's groupBy coalesce + the row mapper so the page
// list and the CSV row agree rank-for-rank.
const SEV_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export type AlertSeveritySortRow = Pick<AlertItem, 'id' | 'severity'> & {
  hostname?: string | null;
};

function serverSeverityRank(sev: string | null | undefined): number {
  const key = (sev ?? '').toLowerCase();
  return SEV_RANK[key] ?? 0;
}

// Prisma enum declaration order in `prisma/schema/alerts.prisma`:
// open (0) → in_progress (1) → resolved (2) → false_positive (3).
// Ascending → open first; false_positive sits at the end so a
// 'status' sort surfaces the active states ahead of suppressed ones.
// Falsely-positive values fall through to `Number.MAX_SAFE_INTEGER` so
// an unrecognized status never silently sinks to the bottom (matches
// the historical "unknown → bottom" posture so the SQL `orderBy` branch
// and the in-app comparator agree on the rank).
const STATUS_ORDINAL: Record<string, number> = {
  open: 0,
  in_progress: 1,
  resolved: 2,
  false_positive: 3,
};

function statusOrdinal(s: string): number {
  return STATUS_ORDINAL[s] ?? Number.MAX_SAFE_INTEGER;
}

function compareDateTimestamps(aTime: number, bTime: number, direction: 'asc' | 'desc'): number {
  const aValid = Number.isFinite(aTime);
  const bValid = Number.isFinite(bTime);

  // Keep unusable timestamps in the collection, but place them after usable
  // values in either direction. If both are unusable, the caller's id
  // tiebreak remains deterministic.
  if (!aValid && !bValid) return 0;
  if (!aValid) return 1;
  if (!bValid) return -1;
  return direction === 'asc' ? aTime - bTime : bTime - aTime;
}

function compareHostname(a: string | null | undefined, b: string | null | undefined): number {
  const aHost = (a ?? '').trim().toLowerCase();
  const bHost = (b ?? '').trim().toLowerCase();
  if (aHost === bHost) return 0;
  if (!aHost) return 1;
  if (!bHost) return -1;
  return compareCodeUnits(aHost, bHost);
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareSeverityTies(
  a: { id: string; hostname?: string | null },
  b: { id: string; hostname?: string | null },
): number {
  return compareHostname(a.hostname, b.hostname) || compareCodeUnits(a.id, b.id);
}

export function compareAlertsBySeverity(
  a: AlertSeveritySortRow,
  b: AlertSeveritySortRow,
  sort: 'severity' | 'severity:asc',
): number {
  const aRank = serverSeverityRank(a.severity);
  const bRank = serverSeverityRank(b.severity);
  const aUnknown = aRank === 0;
  const bUnknown = bRank === 0;

  // Unknown and null values are outside the four requested severity
  // levels. Keep them after the known levels in both directions so the
  // ascending view begins with low rather than an unrecognized value.
  if (aUnknown !== bUnknown) return aUnknown ? 1 : -1;

  if (sort === 'severity') {
    const rankCmp = bRank - aRank;
    if (rankCmp !== 0) return rankCmp;
    return compareSeverityTies(a, b);
  }

  const rankCmp = aRank - bRank;
  if (rankCmp !== 0) return rankCmp;
  return compareSeverityTies(a, b);
}

export function compareAlertsBySort(a: AlertItem, b: AlertItem, sort: AlertSortKey): number {
  const createdAtDate = (value: string | null | undefined): Date => {
    const timestamp = value ? Date.parse(value) : Number.NaN;
    return new Date(Number.isFinite(timestamp) ? timestamp : 0);
  };

  return compareAlertRowsBySort(
    {
      id: a.id,
      severity: a.severity,
      hostname: a.asset.host,
      status: a.status,
      createdAt: createdAtDate(a.createdAt),
      lastActivityAt: a.lastActivityAt ? new Date(a.lastActivityAt) : null,
      priorityScore: a.asset.riskScore,
    },
    {
      id: b.id,
      severity: b.severity,
      hostname: b.asset.host,
      status: b.status,
      createdAt: createdAtDate(b.createdAt),
      lastActivityAt: b.lastActivityAt ? new Date(b.lastActivityAt) : null,
      priorityScore: b.asset.riskScore,
    },
    sort,
  );
}

// Projection-shaped comparator for callers that already hold
// `(id, severity, hostname, status, createdAt)` (e.g. the CSV export
// route, which uses a narrower `select:` than the list `include:`). Same semantics
// as `compareAlertsBySort` — UNUSED on the keystream-cursor export path
// because that path already orders via SQL `orderBy`, but kept here so
// the export buffer can re-rank a small projection without lifting the
// full `AlertItem` row shape.
//
// The input shape widens to carry `lastActivityAt: Date | null` so the
// `lastActivity` / `lastActivity:asc` branches can rank off the derived
// column. The route layer (list + export.csv) computes the resolved
// Date for every page / batch and hands it in; for rows whose
// derivation resolves to null (a brand-new row with no notes AND no
// remediation stamp — the cold-start case the helper now omits from
// the map), the comparator falls through to `createdAt` so the row
// still ranks on its creation timestamp instead of sinking to the
// bottom.
export function compareAlertRowsBySort(
  a: {
    id: string;
    severity: string | null;
    hostname?: string | null;
    status: string;
    createdAt: Date;
    lastActivityAt: Date | null;
    priorityScore: number | null | undefined;
  },
  b: {
    id: string;
    severity: string | null;
    hostname?: string | null;
    status: string;
    createdAt: Date;
    lastActivityAt: Date | null;
    priorityScore: number | null | undefined;
  },
  sort: AlertSortKey,
): number {
  if (sort === 'severity') {
    const aRank = serverSeverityRank(a.severity);
    const bRank = serverSeverityRank(b.severity);
    if ((aRank === 0) !== (bRank === 0)) return aRank === 0 ? 1 : -1;
    const rankCmp = bRank - aRank;
    if (rankCmp !== 0) return rankCmp;
    return compareSeverityTies(a, b);
  }
  if (sort === 'severity:asc') {
    const aRank = serverSeverityRank(a.severity);
    const bRank = serverSeverityRank(b.severity);
    if ((aRank === 0) !== (bRank === 0)) return aRank === 0 ? 1 : -1;
    const rankCmp = aRank - bRank;
    if (rankCmp !== 0) return rankCmp;
    return compareSeverityTies(a, b);
  }
  if (sort === 'status') {
    const statusCmp = statusOrdinal(a.status) - statusOrdinal(b.status);
    if (statusCmp !== 0) return statusCmp;
    const dateCmp = compareDateTimestamps(a.createdAt.getTime(), b.createdAt.getTime(), 'desc');
    if (dateCmp !== 0) return dateCmp;
    return b.id.localeCompare(a.id);
  }
  if (sort === 'lastActivity') {
    // Mirror the `compareAlertsBySort` `lastActivity` branch: rank
    // on `lastActivityAt ?? createdAt` (in ms) DESC, then
    // createdAt-desc then id-desc. The `??` fallback is
    // defense-in-depth — the route layer resolves every row's
    // `lastActivityAt` to a Date today, but the typed nullable
    // keeps the comparator hot-swappable against future cold-
    // start cases without touching this branch.
    const aAt = a.lastActivityAt ?? a.createdAt;
    const bAt = b.lastActivityAt ?? b.createdAt;
    const dateCmp = compareDateTimestamps(aAt.getTime(), bAt.getTime(), 'desc');
    if (dateCmp !== 0) return dateCmp;
    const tieCmp = compareDateTimestamps(a.createdAt.getTime(), b.createdAt.getTime(), 'desc');
    if (tieCmp !== 0) return tieCmp;
    return b.id.localeCompare(a.id);
  }
  if (sort === 'lastActivity:asc') {
    // Ascending mirror of the `lastActivity` branch — same
    // `?? createdAt` fallback so a null-stamp row ranks against
    // the ascend direction; tiebreaks also flip to ascending so
    // the multi-key sort stays coherent.
    const aAt = a.lastActivityAt ?? a.createdAt;
    const bAt = b.lastActivityAt ?? b.createdAt;
    const dateCmp = compareDateTimestamps(aAt.getTime(), bAt.getTime(), 'asc');
    if (dateCmp !== 0) return dateCmp;
    const tieCmp = compareDateTimestamps(a.createdAt.getTime(), b.createdAt.getTime(), 'asc');
    if (tieCmp !== 0) return tieCmp;
    return a.id.localeCompare(b.id);
  }
  if (sort === 'riskScore' || sort === 'riskScore:asc') {
    const aScore = a.priorityScore ?? null;
    const bScore = b.priorityScore ?? null;
    let scoreCmp = 0;
    if (aScore == null && bScore != null) scoreCmp = 1;
    else if (aScore != null && bScore == null) scoreCmp = -1;
    else if (aScore != null && bScore != null) {
      scoreCmp = sort === 'riskScore' ? bScore - aScore : aScore - bScore;
    }
    if (scoreCmp !== 0) return scoreCmp;
    const dateCmp = compareDateTimestamps(a.createdAt.getTime(), b.createdAt.getTime(), 'desc');
    if (dateCmp !== 0) return dateCmp;
    return b.id.localeCompare(a.id);
  }
  if (sort === 'created:asc') {
    const dateCmp = compareDateTimestamps(a.createdAt.getTime(), b.createdAt.getTime(), 'asc');
    if (dateCmp !== 0) return dateCmp;
    return a.id.localeCompare(b.id);
  }
  // 'created' — fallthrough default. Same posture as the
  // `compareAlertsBySort` 'created' branch above: rating on
  // `createdAt` DESC then `id` DESC so a monotonic-keyset cursor
  // is stable across pages even when two rows share the same
  // millisecond stamp.
  const dateCmp = compareDateTimestamps(a.createdAt.getTime(), b.createdAt.getTime(), 'desc');
  if (dateCmp !== 0) return dateCmp;
  return b.id.localeCompare(a.id);
}
