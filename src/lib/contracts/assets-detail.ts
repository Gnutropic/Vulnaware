// @polsia:user-owned — Wire contract for the per-host asset detail page
// served at /assets/[host]. Pure zod schemas, NO server-only / db imports —
// the same posture as assets.ts so the route handler at
// src/app/api/assets/[host]/route.ts and the client island at
// src/components/dashboard/asset-detail-client.tsx both parse against the
// same source of truth.
//
// Grouping key (vs. the rollup at /assets which groups by the composite
// `host:port/protocol`): this contract groups by raw `Asset.host` only.
// Two alerts at `${host}:443/tcp` and `${host}:80/tcp` unify on a single
// `/assets/<host>` detail page so an operator triaging a noisy hostname
// sees the cross-probe arm picture in one place.
//
// `createdAt` is the ONLY non-null timestamp in `AssetDetailAlertItem` —
// the route stamps it from `Alert.createdAt` (DB column is non-null).
// `severity` stays nullable because it's a free-form string column.

import { z } from 'zod';
import { AlertStatus } from '@/lib/contracts/alerts';
import { AssetType } from '@/lib/contracts/assets';

// Bucket counts per severity tier. Mirrors the shape of
// `AssetRollupRow.severityCounts` (src/lib/contracts/assets.ts) so cross-
// page consumers can compose. These counts are unresolved-only: the server
// includes alerts whose status is `open` or `in_progress` and excludes
// `resolved` and `false_positive`. Unknown or null severities are folded into
// the existing `low` bucket.
export const AssetDetailSeverityCounts = z.object({
  critical: z.number().int().nonnegative(),
  high: z.number().int().nonnegative(),
  medium: z.number().int().nonnegative(),
  low: z.number().int().nonnegative(),
});

// Per-alert row subset rendered on /assets/[host]. NO asset subfield —
// the host IS the asset, no need to round-trip the per-port/protocol
// triple (one row per port/protocol carries the same value back and
// would force the client island to filter). `cveId` is nullable-safe via
// the route's pre-stamp; `severity` keeps its permissive null because
// it's stored as a free-form string.
export const AssetDetailAlertItem = z.object({
  id: z.string(),
  cveId: z.string(),
  severity: z.string().nullable(),
  status: AlertStatus,
  createdAt: z.string(),
  port: z.number().int(),
  protocol: z.string(),
  acknowledgedAt: z.string().nullable(),
});

export const RecentAssetScan = z.object({
  id: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
});

// Full envelope served by GET /api/assets/<host>. `alerts.total` is the
// full row count pre-cap; `alerts.shown` is the rows that made it into
// `items` so the client island can render "Showing N of M" without a
// second query. `dominantSeverity` is the highest ordinal tier present
// at this host — mirrors the top-affected-assets tile at
// src/lib/business/dashboard-top-assets.ts so the badge styling stays
// byte-equal between the two surfaces.
export const AssetDetail = z.object({
  host: z.string(),
  // Dominant asset-type literal for the host — derived on the server
  // from the same `inferAssetType` + `pickDominantAssetType` ladder
  // the /assets rollup uses so the detail page's `Type <x>` chip
  // matches the /assets rollup's `Type` column byte-for-byte. Comes
  // from the contributing alert's `finding.asset.serviceHint` /
  // `finding.asset.port` rather than a stored `Asset.type` column
  // (CveEntry / VulnerabilityFinding / Asset don't carry one — see
  // src/lib/business/asset-type.ts for the rank ladder).
  assetType: AssetType,
  firstSeen: z.string(),
  lastSeen: z.string(),
  latestScanAt: z.string().datetime().nullable(),
  latestScanStatus: z.enum(['queued', 'running', 'completed', 'failed']).nullable(),
  recentScans: z.array(RecentAssetScan),
  openCount: z.number().int().nonnegative(),
  unresolvedCount: z.number().int().nonnegative(),
  // Count of alerts on the host the team has stamped as remediated —
  // `Alert.remediatedAt IS NOT NULL`. Counts across the contributing
  // alert set (NOT just open rows) so a host whose alerts are all
  // remediated still surfaces a meaningful Remediated tile on the
  // detail card. Computed on the full pre-cap `rows` slice so the
  // count badge stays accurate on noisy hosts even when the wire
  // items array is capped to MAX_DETAIL_ALERTS.
  remediatedCount: z.number().int().nonnegative(),
  // Count of alerts on the host with an ACTIVE snooze window
  // (`Alert.snoozedUntil > now`). Same full-slice compute posture as
  // `remediatedCount` so a noisy host's snoozed count is accurate
  // regardless of the cap on the wire-items array. Byte-matches the
  // bulk-resolve / claim "exclude future snoozes" guarantee verbatim
  // so the Snoozed tile's number is the same one the /alerts Snoozed
  // chip would stamp against the same set.
  snoozedCount: z.number().int().nonnegative(),
  severityCounts: AssetDetailSeverityCounts,
  dominantSeverity: z.enum(['critical', 'high', 'medium', 'low']).nullable(),
  alerts: z.object({
    items: z.array(AssetDetailAlertItem),
    total: z.number().int().nonnegative(),
    shown: z.number().int().nonnegative(),
  }),
});

// Decode shape for the dynamic route segment. Charset is permissive
// enough for IPv4 dotted notation AND IPv6 (which carries colons) but
// tight enough that a `/` slashes through and 400s — a hostname with
// `/` is unambiguously a path-traversal attempt. The route layer
// normalizes (lowercases + trims + decodeURIComponent) BEFORE applying
// this schema; this schema only validates the resulting string shape.
const HOST_REGEX = /^[a-zA-Z0-9:._-]+$/;

export const AssetDetailPathParam = z.object({
  host: z
    .string()
    .min(1)
    .max(253)
    .refine((v) => HOST_REGEX.test(v), {
      message: 'Host must contain only letters, digits, ":", ".", "_" or "-".',
    }),
});

export type AssetDetailSeverityCounts = z.infer<typeof AssetDetailSeverityCounts>;
export type AssetDetailAlertItem = z.infer<typeof AssetDetailAlertItem>;
export type RecentAssetScan = z.infer<typeof RecentAssetScan>;
export type AssetDetail = z.infer<typeof AssetDetail>;
export type AssetDetailPathParam = z.infer<typeof AssetDetailPathParam>;
