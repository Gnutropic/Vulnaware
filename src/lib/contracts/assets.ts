// @polsia:user-owned — Public-facing wire contracts for the per-team asset
// rollup. Pure zod schemas, NO server-only / db imports — the same posture
// as alerts.ts so the JSON route, the CSV route, and the /assets page all
// share one source of truth.
//
// Asset identity is the raw `Asset.host`, NOT the composite
// `host:port/protocol` the original rollup keyed on. One row per host
// collapses every port/protocol that host listened on into a single
// triagable row so a noisy multi-port host doesn't fragment across
// several near-duplicates in the table. The composite wire identity
// stays in /alerts's `?asset=` chip filter for per-port narrowing —
// that lane is untouched.
//
// The rollup is recomputed on every read so a finding's
// lateness/snooze/severity stays in lockstep with the /alerts page's
// row data, with no caching tier to keep in sync.

import { z } from 'zod';
import { AlertStatus } from '@/lib/contracts/alerts';

export const AssetSeverity = z.enum(['critical', 'high', 'medium', 'low']);

export const AssetScanRecency = z.enum([
  'all',
  'last24h',
  'last7d',
  'last30d',
  'noRecent30d',
  'older',
  'never',
]);

export const AssetRiskTrend = z.enum(['rising', 'falling', 'unchanged']);

// Presence of unresolved (open or in-progress) alerts on an asset. The
// default keeps the existing inventory view unchanged.
export const AssetAlertPresence = z.enum(['all', 'with', 'without']);

// Stable, enumerable asset-type literal the helper
// `@/lib/business/asset-type` emits. The wire enum mirrors the
// helper's literal set 1:1 so the zod refinement is the single source
// of truth for the type column. Mirror across JSON route, CSV route,
// and client island to keep round-trip byte-for-byte.
export const AssetType = z.enum(['web', 'ssh', 'database', 'mail', 'api', 'unknown']);

export const AssetScanStatus = z.enum(['queued', 'running', 'completed', 'failed']);

// One rolled-up row per host (keyed by raw `Asset.host`).
// `openCount` is the count of alerts on this host whose `status ===
// 'open'`; `criticalCount` is the headline triage metric — the count
// of alerts whose severity bucket is `critical` (open OR otherwise).
// Operators want to see critical alerts that are currently snoozed or
// in-progress so a triage decision can weigh them, so `criticalCount`
// counts across the full contributing alert set, not the open slice
// alone. `assetType` derives from `Asset.serviceHint` (preferred) or
// the contributing row's port (fallback) — see the helper spec for
// the rank ladder used when multiple contributions disagree.
// `lastActivityAt` is the per-host MAX of each contributing alert's
// derived `lastActivityAt` (noteMax → remediatedAt → createdAt); null
// when the underlying helper returns no row that contributes a stamp.
export const AssetRollupRow = z.object({
  // Canonical row primary identifier — matches the host-only grouping
  // key, NOT the composite the rollup used to emit. The existing
  // /api/alerts `parseAssetName` regex still recognizes composite
  // shape, so a deep-link using `?asset=<host>` via /alerts wouldn't
  // match; that's why this refactor routes the drill-down through
  // `?q=<host>` instead — see the deep-link note in
  // /components/dashboard/assets-table.tsx.
  name: z.string(),
  // Asset type (derived). Stable literal — see AssetType enum above.
  assetType: AssetType,
  // Total open alert count for the host.
  openCount: z.number().int().nonnegative(),
  // Total unresolved alert count for the host. Includes both `open` and
  // `in_progress` statuses, independent of the inventory's status filter.
  unresolvedCount: z.number().int().nonnegative(),
  // Highest severity among this host's unresolved alerts in the active
  // workspace, independent of inventory severity/status filters. Null when
  // the host has no unresolved alerts.
  highestUnresolvedSeverity: AssetSeverity.nullable(),
  // Critical alert count (the headline triage metric). Counts all
  // severity==='critical' rows on the host regardless of status, so
  // snoozed / in-progress / false_positive criticals still surface.
  criticalCount: z.number().int().nonnegative(),
  // Highest non-null VulnerabilityFinding.priorityScore among the
  // contributing alerts. Null means the host has no stored score.
  riskScore: z.number().nullable(),
  // Signed change from the earliest to latest usable dated scan score in
  // the trailing 30-day window. Null means there are fewer than two points.
  riskScoreChange: z.number().finite().nullable(),
  // ISO-8601 string of MAX(Alert.lastActivityAt) over the
  // contributing alerts; null when no contributing alert produces a
  // resolved stamp.
  lastActivityAt: z.string().nullable(),
  // ISO-8601 string of the newest Scan.startedAt for this host in the
  // active workspace; null when no scan exists for the host.
  latestScanAt: z.string().datetime().nullable(),
  // Outcome of the same newest scan as `latestScanAt`; null when no scan
  // exists for the host.
  latestScanStatus: AssetScanStatus.nullable(),
  // Number of distinct workspace-scoped Scan records for this host in the
  // inclusive rolling 30-day window, excluding future-dated records.
  scanCount30d: z.number().int().nonnegative(),
});

export const AssetList = z.object({
  items: z.array(AssetRollupRow),
  total: z.number().int(),
});

const AssetMinimumRiskScore = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.coerce.number().finite().min(0).max(10).optional(),
);

// Query schema for GET /api/assets?… mirrors AlertQuery's `severity` /
// `status` shape so the same chip-row semantics carry over. Free-text
// `q` narrows by host substring; absent = no host filter.
export const AssetQuery = z.object({
  severity: AssetSeverity.optional(),
  // Reuse the alert-status enum so the chip-row stays consistent with
  // /alerts. An optional `status='resolved'` widens the rollup to
  // include currently-resolved alerts rather than the default "open only"
  // posture — operators explicitly opt in via a chip click.
  status: AlertStatus.optional(),
  q: z.string().optional(),
  // Empty values are treated like an omitted filter so clearing the
  // URL-backed control has the same semantics as removing the key.
  minRiskScore: AssetMinimumRiskScore,
  scanRecency: z.preprocess(
    (value) => (value === '' ? undefined : value),
    AssetScanRecency.default('all'),
  ),
  latestScanStatus: z.preprocess(
    (value) => (value === '' ? undefined : value),
    AssetScanStatus.optional(),
  ),
  // This is distinct from scanRecency='never': it excludes a host only
  // after at least one scan for that host completed in the active workspace.
  neverScanned: z.preprocess((value) => {
    if (value === undefined || value === '') return false;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  }, z.boolean()),
  // Empty values are treated like an omitted filter so old /assets links and
  // the clear action keep the complete inventory, including null changes.
  riskTrend: z.preprocess((value) => (value === '' ? undefined : value), AssetRiskTrend.optional()),
  alertPresence: z.preprocess(
    (value) => (value === '' ? undefined : value),
    AssetAlertPresence.default('all'),
  ),
  // Sort keys mirror the on-screen column order. `'openCount'` is the
  // resting default — most-open first — and is what a freshly-pasted
  // URL lands on. `'openCount:asc'` is the Open alerts column's
  // ascending arm (fewest-open first) — bound on a single comparator
  // so the secondary `name asc` tiebreak holds. `'critical'` orders
  // by descending criticalCount so a triage view sorts the loudest
  // hosts to the top. `'lastActivity'` orders by descending
  // lastActivityAt (nulls sink to the bottom) for a "what changed
  // recently" view. `'name'` is the alphabetical fallback.
  // `'firstSeen'` and `'lastSeen'` stay accepted by the enum for
  // legacy bookmarks — they reconcile to a stable ordering
  // (createdAt desc on the contributing alert set, then name asc) so
  // a permalink doesn't 400; it's just not surfaced in the dropdown.
  // `'unresolvedCount'` and `'unresolvedCount:asc'` sort by the independent
  // open/in-progress alert count, regardless of inventory status/severity
  // filters. Host name ascending is the deterministic tie-breaker.
  // `'riskScoreChange'` and `'riskScoreChange:asc'` sort by the signed
  // 30-day risk-score change, not the current risk score. Hosts without
  // enough dated history remain visible and sort last in either direction.
  // `'latestScanAt'` and `'latestScanAt:asc'` order by the newest scan
  // timestamp for each host. Hosts without workspace scan history remain
  // visible at the end in either direction.
  sort: z
    .enum([
      'openCount',
      'openCount:asc',
      'unresolvedCount',
      'unresolvedCount:asc',
      'riskScore',
      'riskScore:asc',
      'riskScoreChange',
      'riskScoreChange:asc',
      'latestScanAt',
      'latestScanAt:asc',
      'critical',
      'lastActivity',
      'name',
      'firstSeen',
      'lastSeen',
    ])
    .default('openCount'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export type AssetSeverity = z.infer<typeof AssetSeverity>;
export type AssetScanRecency = z.infer<typeof AssetScanRecency>;
export type AssetRiskTrend = z.infer<typeof AssetRiskTrend>;
export type AssetAlertPresence = z.infer<typeof AssetAlertPresence>;
export type AssetType = z.infer<typeof AssetType>;
export type AssetScanStatus = z.infer<typeof AssetScanStatus>;
export type AssetRollupRow = z.infer<typeof AssetRollupRow>;
export type AssetList = z.infer<typeof AssetList>;
export type AssetQuery = z.infer<typeof AssetQuery>;
export type AssetSortKey = AssetQuery['sort'];
