// @polsia:user-owned — Per-host asset detail read for GET /api/assets/<host>.
// Server-only: imports `server-only` + `prisma`. The route layer at
// src/app/api/assets/[host]/route.ts is the ONLY caller; never called from
// a Server Component, page body, or layout (data-plane rule).
//
// Strategy: ONE `prisma.alert.findMany` that reads EVERY alert joined to
// `finding → asset` for the caller's team where `asset.host === <host>`,
// plus the in-app reduce that derives first/last seen, open count, and the
// highest ordinal tier as the dominant severity badge value. Unresolved
// severity counts come from a separate uncapped groupBy query so they are
// not distorted by the detail projection cap.
//
// `finding: { isNot: null }` is implicit via the host filter — a missing
// finding means a missing asset, which means no host match, so we don't
// need an extra clause. The explicit `findingId: { not: 'manual' }`
// clause keeps the Prisma `where` type-clean (mirror of the /api/assets
// route at src/app/api/assets/route.ts:97 — manual rows have no Asset
// row so the by-host reduce would never see them anyway, but the filter
// makes the intent loud on the wire).
//
// Sort posture:
//   - Prisma `orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }]`
//     gives lexicographic severity (critical|c3 first naturally, but
//     high|h1 doesn't tie with medium|m — fine for our needs; the in-
//     app group below re-sorts by the SEVERITY_ORDINAL map so the wire
//     order is severity-desc-then-newest-desc).
//   - The severity tier is then bucketed into the four-tuple counts and
//     the dominant severity is "highest ordinal tier seen at this host"
//     (re-derived from the per-row reduce so the wire value matches the
//     /api/dashboard/top-assets tile's contract byte-for-byte).
//
// Cap: `MAX_DETAIL_ALERTS = 200` so a noisy host doesn't drive a multi-
// MB response or a 5-min Tab. The wire envelope carries `alerts.total`
// (full row count pre-cap) and `alerts.shown` (rows in `items`) so the
// client island can render "Showing N of M" without a second query.
// Cap is applied AFTER sort so severity tier coverage is preserved.

import 'server-only';
import type { STANDARD_SEVERITY_VALUES } from '@/lib/business/alerts-severity';
import {
  type AssetTypeLiteral,
  inferAssetType,
  pickDominantAssetType,
} from '@/lib/business/asset-type';
import { prisma } from '@/lib/db';

// Severity tier ordering — kept VERBATIM in lockstep with the same map
// at src/lib/business/dashboard-top-assets.ts:62-78 so the /assets/<host>
// badge and the top-affected-assets tile never drift. Re-exported here
// so the same ordinal map is visible to the reduce without crossing
// module boundaries. (The plan locks the dual definition: ONE source of
// ordinals would mean lifting these into a shared helper file — left
// for a follow-up cleanup.)
export const SEVERITY_ORDINAL: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export const ORDINAL_TO_LITERAL: Record<number, 'critical' | 'high' | 'medium' | 'low'> = {
  4: 'critical',
  3: 'high',
  2: 'medium',
  1: 'low',
};

const MAX_ROWS = 100_000;
const MAX_DETAIL_ALERTS = 200;

export const UNRESOLVED_ALERT_STATUSES = ['open', 'in_progress'] as const;

export type AssetDetailSeverityCounts = {
  [severity in (typeof STANDARD_SEVERITY_VALUES)[number]]: number;
};

export interface AssetDetailSeverityGroup {
  severity: string | null;
  _count: number;
}

// Per-tier tally uses the uncapped unresolved aggregation for the
// `severityCounts` field while the same accumulator carries the full alert
// projection used for the rest of the detail envelope.
interface DetailAccumulator {
  host: string;
  // Running dominant asset-type literal across the contributing alert
  // rows. `null` pre first row, then monotonically upgraded via
  // `pickDominantAssetType(assetType, inferAssetType(...))` against
  // the same rank ladder the /assets rollup uses. Mirrors
  // src/app/api/assets/route.ts:130-156 verbatim so the detail page's
  // asset-type chip and the rollup's asset-type column never drift.
  assetType: AssetTypeLiteral | null;
  firstSeen: Date;
  lastSeen: Date;
  openCount: number;
  // Counts for remediated (`Alert.remediatedAt IS NOT NULL`) and
  // active-snooze (`Alert.snoozedUntil > now`) alerts on the host.
  // Both roll up on the FULL pre-cap `rows` slice so a noisy host's
  // count badge stays accurate when the wire-items array is capped
  // to MAX_DETAIL_ALERTS below. Byte-matches the /alerts Snoozed chip
  // semantic (`gt` semantics verbatim) and the bulk-remediate
  // helper's stamped-only posture.
  remediatedCount: number;
  snoozedCount: number;
  severityCounts: AssetDetailSeverityCounts;
  bestOrdinal: number;
  rows: {
    id: string;
    cveId: string;
    severity: string | null;
    status: 'open' | 'in_progress' | 'resolved' | 'false_positive';
    createdAt: Date;
    port: number;
    protocol: string;
    acknowledgedAt: Date | null;
    // `serviceHint` + `snoozedUntil` + `remediatedAt` carried on the
    // reduce row so the asset-type / remediated / snoozed counters
    // don't have to dispatch a second query below. `serviceHint`
    // drives the asset-type inference; `snoozedUntil` and
    // `remediatedAt` drive the two new wire counters.
    serviceHint: string | null;
    snoozedUntil: Date | null;
    remediatedAt: Date | null;
  }[];
}

// Bucket a free-form `Alert.severity` to the canonical lower-tier literal.
// Verbatim copy from src/app/api/assets/route.ts:50-58.
function bucketSeverity(value: string | null | undefined): keyof AssetDetailSeverityCounts {
  const key = (value ?? '').toLowerCase();
  if (key === 'critical') return 'critical';
  if (key === 'high') return 'high';
  if (key === 'medium') return 'medium';
  return 'low';
}

export function foldUnresolvedSeverityCounts(
  groups: readonly AssetDetailSeverityGroup[],
): AssetDetailSeverityCounts {
  const counts: AssetDetailSeverityCounts = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };

  for (const group of groups) {
    counts[bucketSeverity(group.severity)] += group._count;
  }

  return counts;
}

// Shape returned by `loadAssetDetail`. Matches the `AssetDetail` zod
// envelope on the wire so the route can validate via `AssetDetail.parse`
// after a single round trip. Kept as a plain TS interface so the
// contract stays the single source of truth for runtime validation.
export interface AssetDetailData {
  host: string;
  assetType: AssetTypeLiteral;
  firstSeen: string;
  lastSeen: string;
  latestScanAt: string | null;
  latestScanStatus: string | null;
  recentScans: {
    id: string;
    status: 'queued' | 'running' | 'completed' | 'failed';
    startedAt: string;
    finishedAt: string | null;
  }[];
  openCount: number;
  unresolvedCount: number;
  remediatedCount: number;
  snoozedCount: number;
  severityCounts: AssetDetailSeverityCounts;
  dominantSeverity: 'critical' | 'high' | 'medium' | 'low' | null;
  alerts: {
    items: {
      id: string;
      cveId: string;
      severity: string | null;
      status: 'open' | 'in_progress' | 'resolved' | 'false_positive';
      createdAt: string;
      port: number;
      protocol: string;
      acknowledgedAt: string | null;
    }[];
    total: number;
    shown: number;
  };
}

export async function loadAssetDetail(teamId: string, host: string): Promise<AssetDetailData> {
  const [rows, recentScans, unresolvedCount, severityGroups] = await Promise.all([
    prisma.alert.findMany({
      where: {
        teamId,
        findingId: { not: 'manual' },
        finding: { asset: { host, scan: { teamId } } },
      },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: MAX_ROWS,
      select: {
        id: true,
        severity: true,
        status: true,
        createdAt: true,
        acknowledgedAt: true,
        // New fields powering `remediatedCount` and `snoozedCount` in
        // the wire envelope. Columns are returned by default on the
        // existing Alert projection; the explicit `select` inclusion
        // is intentional so the projection stays audited and a future
        // contributor widening the helper's reads sees them on the
        // card right next to the existing select arms.
        remediatedAt: true,
        snoozedUntil: true,
        finding: {
          select: {
            cveId: true,
            // `serviceHint` powers the dominant `assetType` derivation
            // on the wire envelope. Added alongside `host` / `port` /
            // `protocol` so a single Prisma round trip feeds both the
            // AssetDetailAlertItem row stamps + the `inferAssetType`
            // ladder for the chip on the detail header card.
            asset: { select: { host: true, port: true, protocol: true, serviceHint: true } },
          },
        },
      },
    }),
    prisma.scan.findMany({
      where: {
        teamId,
        assets: { some: { host } },
      },
      orderBy: { startedAt: 'desc' },
      take: 5,
      select: { id: true, status: true, startedAt: true, finishedAt: true },
    }),
    // Keep this count separate from the capped alert projection above so the
    // summary reflects every unresolved alert for the host.
    prisma.alert.count({
      where: {
        teamId,
        findingId: { not: 'manual' },
        status: { in: [...UNRESOLVED_ALERT_STATUSES] },
        finding: { asset: { host, scan: { teamId } } },
      },
    }),
    // Keep this aggregation uncapped. The detail alert projection is capped
    // for response size, but the severity breakdown must represent the full
    // unresolved load in the active workspace.
    prisma.alert.groupBy({
      by: ['severity'],
      where: {
        teamId,
        findingId: { not: 'manual' },
        status: { in: [...UNRESOLVED_ALERT_STATUSES] },
        finding: { asset: { host, scan: { teamId } } },
      },
      _count: true,
    }),
  ]);

  const severityCounts = foldUnresolvedSeverityCounts(severityGroups);
  const latestScan = recentScans[0];
  const serializedRecentScans = recentScans.map((scan) => ({
    id: scan.id,
    status: scan.status as 'queued' | 'running' | 'completed' | 'failed',
    startedAt: scan.startedAt.toISOString(),
    finishedAt: scan.finishedAt?.toISOString() ?? null,
  }));

  if (rows.length === 0) {
    // Ghost envelope — the route's 404 branch on `alerts.total === 0`
    // (relaxed from the prior `total===0 && openCount===0` gate so
    // a host whose alerts are all lifecycle-closed still surfaces
    // the detail page rather than a 404). The ghost envelope below
    // is only reached when Prisma returns ZERO rows — which the
    // `findMany` does when the team has no alert rows on this host.
    return {
      host,
      // `'unknown'` satisfies the AssetType enum refine on the wire
      // (zod's z.enum never accepts null), so a zero-row envelope
      // still parses through `AssetDetailSchema.parse(detail)`. The
      // route's 404-rejection kicks in BEFORE this envelope ever
      // reaches the wire.
      assetType: 'unknown',
      firstSeen: new Date(0).toISOString(),
      lastSeen: new Date(0).toISOString(),
      latestScanAt: latestScan?.startedAt.toISOString() ?? null,
      latestScanStatus: latestScan?.status ?? null,
      recentScans: serializedRecentScans,
      openCount: 0,
      unresolvedCount,
      remediatedCount: 0,
      snoozedCount: 0,
      severityCounts,
      dominantSeverity: null,
      alerts: { items: [], total: 0, shown: 0 },
    };
  }

  // Reduce across rows. firstSeen/lastSeen are min/max of `createdAt`,
  // not derived from the page query ordering (which already sorts desc)
  // — we're permissive on the order so an upstream Prisma sort drift
  // doesn't silently invert our local min/max.
  const acc: DetailAccumulator = {
    host: rows[0]?.finding?.asset?.host ?? host,
    // `null` pre first row so `pickDominantAssetType` short-circuits
    // on the first iteration (the seed handler states `prior === null
    // short-circuits to the candidate` so the boot row's inferred
    // literal lands without a comparison arm).
    assetType: null,
    firstSeen: rows[0]?.createdAt ?? new Date(0),
    lastSeen: rows[0]?.createdAt ?? new Date(0),
    openCount: 0,
    remediatedCount: 0,
    snoozedCount: 0,
    severityCounts,
    bestOrdinal: 0,
    rows: [],
  };
  // Captured once per call so every `snoozedUntil > now` comparison
  // reads the same instant — the snoozedCount badge mirrors the
  // /alerts Snoozed chip's `gt` semantic verbatim, which uses the
  // server's `new Date()` once per request rather than re-sampling
  // `Date.now()` per row. Cheap enough to do inline.
  const now = new Date();

  for (const r of rows) {
    if (r.status === 'open') acc.openCount += 1;
    if (r.remediatedAt != null) acc.remediatedCount += 1;
    // Snoozed-counter semantic mirrors the /alerts Snoozed chip:
    // `Alert.snoozedUntil > now` (active window). `gt` (NOT `gte`)
    // byte-matches the bulk-resolve helper and the claim route's
    // "exclude future snoozes" posture verbatim — `gte` would
    // silently re-include rows whose `snoozedUntil === now`
    // (the boundary the bulk-resolve helper skips).
    if (r.snoozedUntil != null && r.snoozedUntil > now) acc.snoozedCount += 1;
    const ordinal = SEVERITY_ORDINAL[(r.severity ?? '').toLowerCase()] ?? 0;
    if (ordinal > acc.bestOrdinal) acc.bestOrdinal = ordinal;
    if (r.createdAt < acc.firstSeen) acc.firstSeen = r.createdAt;
    if (r.createdAt > acc.lastSeen) acc.lastSeen = r.createdAt;
    // Running dominant assetType — each contributing row's
    // `serviceHint + port` resolves via `inferAssetType` and we
    // keep the higher-tier candidate via `pickDominantAssetType`.
    // Mirrors src/app/api/assets/route.ts:130-156 verbatim (its
    // `accumulator.assetType` field is driven through the exact
    // same helper pair) so the detail page's Type chip and the
    // /assets rollup's Type column never drift.
    acc.assetType = pickDominantAssetType(
      acc.assetType,
      inferAssetType({
        serviceHint: r.finding?.asset?.serviceHint ?? null,
        port: r.finding?.asset?.port ?? null,
      }),
    );

    // `cveId` is a non-null column on VulnerabilityFinding per the
    // scan.prisma model — coalescing to '' is only a TypeScript
    // appeasement for the strict-optional input parse; the route's
    // AssetDetailAlertItem.refine keeps the wire envelope clean.
    acc.rows.push({
      id: r.id,
      cveId: r.finding?.cveId ?? '',
      severity: r.severity,
      status: r.status,
      createdAt: r.createdAt,
      port: r.finding?.asset?.port ?? 0,
      protocol: r.finding?.asset?.protocol ?? '',
      acknowledgedAt: r.acknowledgedAt,
      serviceHint: r.finding?.asset?.serviceHint ?? null,
      snoozedUntil: r.snoozedUntil,
      remediatedAt: r.remediatedAt,
    });
  }

  // Re-sort rows by SEVERITY_ORDINAL desc, then createdAt desc, so the
  // wire order is what an operator expects (critical first, then high,
  // inside a tier newest-first). Prisma's lexicographic severity sort
  // is replaced here because `high|h1` doesn't tie with `medium|m` —
  // we want the ordinal-keyed sort for the page render.
  acc.rows.sort((a, b) => {
    const aOrd = SEVERITY_ORDINAL[(a.severity ?? '').toLowerCase()] ?? 0;
    const bOrd = SEVERITY_ORDINAL[(b.severity ?? '').toLowerCase()] ?? 0;
    if (aOrd !== bOrd) return bOrd - aOrd;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  // Cap AFTER the in-app severity sort so the 200-row window still
  // preserves critical/high coverage. `total` is the pre-cap row count
  // so the page can render "Showing N of M".
  const sliced = acc.rows.slice(0, MAX_DETAIL_ALERTS);

  return {
    host: acc.host,
    // `acc.assetType` is non-null at this branch — the reduce loop
    // seeded the field on the first iteration via the `pickDominant
    // AssetType(null, candidate)` short-circuit, so a single-row or
    // multi-row resultset always leaves a defined literal. Falling
    // back to `'unknown'` is just a type-system appeasement — the
    // inner reduce is mandatorily non-null.
    assetType: acc.assetType ?? 'unknown',
    firstSeen: acc.firstSeen.toISOString(),
    lastSeen: acc.lastSeen.toISOString(),
    latestScanAt: latestScan?.startedAt.toISOString() ?? null,
    latestScanStatus: latestScan?.status ?? null,
    recentScans: serializedRecentScans,
    openCount: acc.openCount,
    unresolvedCount,
    remediatedCount: acc.remediatedCount,
    snoozedCount: acc.snoozedCount,
    severityCounts: acc.severityCounts,
    dominantSeverity: ORDINAL_TO_LITERAL[acc.bestOrdinal] ?? null,
    alerts: {
      items: sliced.map((r) => ({
        id: r.id,
        cveId: r.cveId,
        severity: r.severity,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        port: r.port,
        protocol: r.protocol,
        acknowledgedAt: r.acknowledgedAt ? r.acknowledgedAt.toISOString() : null,
      })),
      total: acc.rows.length,
      shown: sliced.length,
    },
  };
}
