// @polsia:user-owned — Per-team asset rollup read. Groups the existing
// alerts table by the raw `Asset.host` on its underlying
// VulnerabilityFinding / Asset row, returning one summary per distinct
// scanned host that has any alert for the caller's team. Mirrors
// alerts/route.ts's gate posture (`requireTeamRole('member')` +
// `setRequestAuth` first) so an anonymous caller gets a 401 and a
// non-team-member caller gets a 403.
//
// Grouping key is `Asset.host` (NOT the composite `host:port/protocol`
// the original rollup keyed on). One row per host collapses every
// port/protocol that host listened on into a single triagable row so
// a noisy multi-port host doesn't fragment across several near-
// duplicates in the table. The composite wire identity stays in
// /alerts's `?asset=` chip filter for per-port narrowing — that lane
// is untouched.
//
// We cannot use Prisma `groupBy({ by: ['finding.asset.host'] })` (relation
// columns are not accepted as `by` keys), so the rollup is computed in app
// code: read up to MAX_ROWS alerts joined to the finding's asset, reduce
// by raw `Asset.host`. Manual alerts with `findingId = 'manual'` carry
// no asset and are excluded via `findingId: { not: 'manual' }` so the
// reducer never sees an undefined host.
//
// Filter behavior:
//   - `severity`/`status` narrow the alert-level `where` upstream — i.e.
//     the rollup reflects "open criticals on this host", not "open
//     anything + post-filtered severity counts".
//   - `q` (a free-text host substring) further narrows upstream. Empty
//     string is treated as no filter (parity with `severity`).
//
// `lastActivityAt` is derived peer-side via
// `computeAlertLastActivityAtForList` over the contributing alert
// `id`/`remediatedAt`/`createdAt` projection, then MAX'd by host and
// stamped to ISO-8601 (`string | null`) on the wire.
//
// Access-control posture: `teamId` is ALWAYS seeded from `ctx.membership.teamId`
// and is never read from the URL. A URL-tampered `teamId=…` parameter is
// silently ignored at the parse layer (`AssetQuery` does not declare a
// `teamId` field) — to fingerprint a leak response requires the caller to
// already have a valid membership cookie.

import 'server-only';
import type { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { computeAlertLastActivityAtForList } from '@/lib/business/alerts-activity';
import {
  type AssetTypeLiteral,
  inferAssetType,
  pickDominantAssetType,
} from '@/lib/business/asset-type';
import { matchesAssetAlertPresence } from '@/lib/business/assets-alert-presence';
import {
  ASSET_UNRESOLVED_ALERT_STATUSES,
  bucketAssetSeverity,
  highestUnresolvedSeverityByHost,
} from '@/lib/business/assets-alert-severity';
import {
  type LatestAssetScan,
  matchesLatestAssetScanStatus,
  recordLatestWorkspaceAssetScan,
  serializeLatestAssetScan,
} from '@/lib/business/assets-latest-scan';
import { loadAssetRiskChanges, matchesAssetRiskTrend } from '@/lib/business/assets-risk-trend';
import { matchesAssetScanRecency } from '@/lib/business/assets-scan-recency';
import { resolveDashboardWorkspaceContext } from '@/lib/business/dashboard-workspace-context';
import { AssetList, AssetQuery } from '@/lib/contracts/assets';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { requireTeamRole } from '@/lib/team-auth';

export const dynamic = 'force-dynamic';

const MAX_ROWS = 100_000;

interface AssetAccumulator {
  host: string;
  openCount: number;
  criticalCount: number;
  riskScore: number | null;
  assetType: AssetTypeLiteral;
  contributingAlertIds: string[];
}

export async function GET(req: Request) {
  return withApiRequest(req, async () => {
    let ctx: Awaited<ReturnType<typeof requireTeamRole>>;
    try {
      ctx = await requireTeamRole('member');
    } catch (res) {
      return res as Response;
    }

    const parsed = AssetQuery.safeParse(
      Object.fromEntries(new URL(req.url).searchParams.entries()),
    );
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'bad_request', issues: parsed.error.flatten() },
        { status: 400 },
      );
    }

    let workspaceContext: Awaited<ReturnType<typeof resolveDashboardWorkspaceContext>>;
    try {
      workspaceContext = await resolveDashboardWorkspaceContext(ctx.user.id);
    } catch {
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
    if (!workspaceContext) {
      return NextResponse.json({ error: 'No active workspace' }, { status: 404 });
    }

    setRequestAuth({ userId: ctx.user.id, teamId: workspaceContext.workspaceId });

    const {
      severity,
      status,
      q,
      minRiskScore,
      scanRecency,
      latestScanStatus,
      neverScanned,
      riskTrend,
      alertPresence,
      sort,
      page,
      pageSize,
    } = parsed.data;
    const hostnameQuery = q?.trim() || undefined;
    const workspaceId = workspaceContext.workspaceId;
    const now = new Date();

    // Compose Prisma `where`. teamId is server-derived (NEVER from URL);
    // severity and q are case-insensitive substrings against the prisma
    // column; status is a strict-enum equality. Manual rows carry
    // `findingId = 'manual'` with no underlying VulnerabilityFinding /
    // Asset — they are excluded via a top-level `findingId: { not: 'manual' }`
    // clause so the host-only reduce never sees an undefined host.
    // The asset's scan must also belong to the active workspace. Keep this
    // relation predicate in the same nested object as the hostname filter so
    // adding q cannot overwrite the workspace boundary.
    const assetWhere: Prisma.AssetWhereInput = {
      scan: { teamId: workspaceId },
      ...(hostnameQuery ? { host: { contains: hostnameQuery, mode: 'insensitive' as const } } : {}),
    };
    const where: Prisma.AlertWhereInput = {
      teamId: workspaceId,
      ...(status ? { status } : {}),
      ...(severity ? { severity } : {}),
      findingId: { not: 'manual' },
      finding: { asset: assetWhere },
    };
    const unresolvedWhere: Prisma.AlertWhereInput = {
      teamId: workspaceId,
      status: { in: [...ASSET_UNRESOLVED_ALERT_STATUSES] },
      findingId: { not: 'manual' },
      finding: { asset: assetWhere },
    };

    try {
      const [rows, unresolvedRows] = await Promise.all([
        prisma.alert.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: MAX_ROWS,
          include: {
            finding: {
              select: {
                priorityScore: true,
                asset: { select: { host: true, port: true, serviceHint: true } },
              },
            },
          },
        }),
        prisma.alert.findMany({
          where: unresolvedWhere,
          select: {
            teamId: true,
            status: true,
            severity: true,
            finding: { select: { asset: { select: { host: true } } } },
          },
        }),
      ]);

      const rollupByKey = new Map<string, AssetAccumulator>();
      for (const r of rows) {
        const asset = r.finding?.asset;
        if (!asset) continue;
        const key = asset.host;
        const existing = rollupByKey.get(key);
        if (!existing) {
          const bucket = bucketAssetSeverity(r.severity);
          rollupByKey.set(key, {
            host: asset.host,
            openCount: r.status === 'open' ? 1 : 0,
            criticalCount: bucket === 'critical' ? 1 : 0,
            riskScore: r.finding?.priorityScore ?? null,
            assetType: inferAssetType({ serviceHint: asset.serviceHint, port: asset.port }),
            contributingAlertIds: [r.id],
          });
          continue;
        }
        const bucket = bucketAssetSeverity(r.severity);
        if (bucket === 'critical') existing.criticalCount += 1;
        if (r.status === 'open') existing.openCount += 1;
        const priorityScore = r.finding?.priorityScore ?? null;
        if (
          priorityScore !== null &&
          (existing.riskScore === null || priorityScore > existing.riskScore)
        ) {
          existing.riskScore = priorityScore;
        }
        // Reconcile asset type across contributions: a host that
        // listened on a database port AND a web port surfaces as
        // `database` (the higher tier in the rank ladder).
        existing.assetType = pickDominantAssetType(
          existing.assetType,
          inferAssetType({ serviceHint: asset.serviceHint, port: asset.port }),
        );
        existing.contributingAlertIds.push(r.id);
      }

      const unresolvedCountByHost = new Map<string, number>();
      const highestSeverityByHost = highestUnresolvedSeverityByHost(
        unresolvedRows.map((row) => ({
          teamId: row.teamId,
          status: row.status,
          severity: row.severity,
          host: row.finding?.asset?.host,
        })),
        workspaceId,
      );
      for (const row of unresolvedRows) {
        const host = row.finding?.asset?.host;
        if (!host) continue;
        unresolvedCountByHost.set(host, (unresolvedCountByHost.get(host) ?? 0) + 1);
      }

      // Derive per-alert `lastActivityAt` via the team-scoped peer-read
      // helper over the contributing `id`/`remediatedAt`/`createdAt`
      // projection. We then MAX by host across the contributing alert
      // ids so the row's `lastActivityAt` reflects the freshest
      // contributing stamp.
      const activityRows = rows.map((r) => ({
        id: r.id,
        remediatedAt: r.remediatedAt,
        createdAt: r.createdAt,
      }));
      const activityMap = await computeAlertLastActivityAtForList(activityRows, workspaceId);

      const lastActivityByKey = new Map<string, Date | null>();
      for (const [key, accumulator] of rollupByKey.entries()) {
        let hostMax: Date | null = null;
        for (const id of accumulator.contributingAlertIds) {
          const stamp = activityMap.get(id) ?? null;
          if (stamp == null) continue;
          if (hostMax == null || stamp.getTime() > hostMax.getTime()) {
            hostMax = stamp;
          }
        }
        lastActivityByKey.set(key, hostMax);
      }

      // Read the newest scan timestamp for every host rollup before
      // recency filtering, sorting, and pagination. The scan relation is
      // workspace-scoped independently of the URL so a host cannot inherit a
      // timestamp from another workspace.
      const rollupHosts = Array.from(rollupByKey.keys());
      const scanRows =
        rollupHosts.length === 0
          ? []
          : await prisma.asset.findMany({
              where: {
                host: { in: rollupHosts },
                scan: { teamId: workspaceId },
              },
              select: {
                host: true,
                scan: { select: { id: true, teamId: true, startedAt: true, status: true } },
              },
            });
      const latestScanByHost = new Map<string, LatestAssetScan>();
      const completedScanHosts = new Set<string>();
      const scanIds30dByHost = new Map<string, Set<string>>();
      const cutoff30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      for (const scanRow of scanRows) {
        if (!recordLatestWorkspaceAssetScan(latestScanByHost, scanRow, workspaceId)) continue;
        if (scanRow.scan.status === 'completed') completedScanHosts.add(scanRow.host);

        const startedAt = scanRow.scan.startedAt.getTime();
        if (startedAt >= cutoff30d.getTime() && startedAt <= now.getTime()) {
          const scanIds = scanIds30dByHost.get(scanRow.host) ?? new Set<string>();
          scanIds.add(scanRow.scan.id);
          scanIds30dByHost.set(scanRow.host, scanIds);
        }
      }

      // Apply all existing inventory filters before loading the history used
      // by the change sort. This keeps the history read bounded to the hosts
      // that can appear in this response while leaving null-history hosts in
      // the unfiltered inventory.
      const thresholdedRollups = Array.from(rollupByKey.entries()).filter(
        ([host, row]) =>
          matchesLatestAssetScanStatus(latestScanByHost.get(host), latestScanStatus) &&
          matchesAssetScanRecency(
            latestScanByHost.get(host)?.startedAt ?? null,
            scanRecency,
            now,
            scanIds30dByHost.get(host)?.size ?? 0,
          ) &&
          (minRiskScore === undefined || (row.riskScore !== null && row.riskScore >= minRiskScore)),
      );
      const completionFilteredRollups = neverScanned
        ? thresholdedRollups.filter(([host]) => !completedScanHosts.has(host))
        : thresholdedRollups;
      const presenceFilteredRollups = completionFilteredRollups.filter(([, row]) =>
        matchesAssetAlertPresence(unresolvedCountByHost.get(row.host) ?? 0, alertPresence),
      );
      const needsRiskScoreChanges =
        riskTrend !== undefined || sort === 'riskScoreChange' || sort === 'riskScoreChange:asc';
      const riskScoreChanges = needsRiskScoreChanges
        ? await loadAssetRiskChanges(
            workspaceId,
            presenceFilteredRollups.map(([host]) => host),
          )
        : null;

      // Sort branches:
      //   - openCount     openCount desc, name asc tiebreak
      //   - openCount:asc openCount asc, name asc tiebreak
      //   - unresolvedCount unresolvedCount desc, name asc tiebreak
      //   - unresolvedCount:asc unresolvedCount asc, name asc tiebreak
      //   - riskScore     riskScore desc, nulls last, name asc
      //   - riskScore:asc riskScore asc, nulls last, name asc
      //   - riskScoreChange / riskScoreChange:asc sort the signed 30-day
      //     change numerically, with null history last and name asc ties.
      //   - latestScanAt / latestScanAt:asc sort by the newest workspace
      //     scan timestamp, keeping hosts without scan history last.
      //   - critical      criticalCount desc, openCount desc, name asc
      //   - lastActivity  lastActivityAt desc (nulls last), name asc
      //   - name          name asc
      //   - firstSeen / lastSeen (legacy permalink forms) — fall back to
      //     openCount desc then name asc so bookmarks don't 400.
      const nameCmp = (a: string, b: string) => a.localeCompare(b);
      const nullsLastByTimestamp = (a: Date | null, b: Date | null) => {
        if (a == null && b == null) return 0;
        if (a == null) return 1;
        if (b == null) return -1;
        return b.getTime() - a.getTime();
      };
      const compareScanTimestamp = (a: Date | null, b: Date | null, ascending: boolean) => {
        if (a == null && b == null) return 0;
        if (a == null) return 1;
        if (b == null) return -1;
        return ascending ? a.getTime() - b.getTime() : b.getTime() - a.getTime();
      };
      function compare(a: AssetAccumulator, b: AssetAccumulator): number {
        const unresolvedCount = (host: string) => unresolvedCountByHost.get(host) ?? 0;

        switch (sort) {
          case 'critical':
            if (a.criticalCount !== b.criticalCount) return b.criticalCount - a.criticalCount;
            if (a.openCount !== b.openCount) return b.openCount - a.openCount;
            return nameCmp(a.host, b.host);
          case 'lastActivity':
            return (
              nullsLastByTimestamp(
                lastActivityByKey.get(a.host) ?? null,
                lastActivityByKey.get(b.host) ?? null,
              ) || nameCmp(a.host, b.host)
            );
          case 'latestScanAt':
          case 'latestScanAt:asc':
            return (
              compareScanTimestamp(
                latestScanByHost.get(a.host)?.startedAt ?? null,
                latestScanByHost.get(b.host)?.startedAt ?? null,
                sort === 'latestScanAt:asc',
              ) || nameCmp(a.host, b.host)
            );
          case 'name':
            return nameCmp(a.host, b.host);
          case 'riskScore':
            if (a.riskScore === null && b.riskScore === null) return nameCmp(a.host, b.host);
            if (a.riskScore === null) return 1;
            if (b.riskScore === null) return -1;
            if (a.riskScore !== b.riskScore) return b.riskScore - a.riskScore;
            return nameCmp(a.host, b.host);
          case 'riskScore:asc':
            if (a.riskScore === null && b.riskScore === null) return nameCmp(a.host, b.host);
            if (a.riskScore === null) return 1;
            if (b.riskScore === null) return -1;
            if (a.riskScore !== b.riskScore) return a.riskScore - b.riskScore;
            return nameCmp(a.host, b.host);
          case 'riskScoreChange':
          case 'riskScoreChange:asc': {
            const aChange = riskScoreChanges?.get(a.host) ?? null;
            const bChange = riskScoreChanges?.get(b.host) ?? null;
            if (aChange === null && bChange === null) return nameCmp(a.host, b.host);
            if (aChange === null) return 1;
            if (bChange === null) return -1;
            if (aChange !== bChange) {
              return sort === 'riskScoreChange' ? bChange - aChange : aChange - bChange;
            }
            return nameCmp(a.host, b.host);
          }
          case 'openCount:asc':
            if (a.openCount !== b.openCount) return a.openCount - b.openCount;
            return nameCmp(a.host, b.host);
          case 'unresolvedCount':
            if (unresolvedCount(a.host) !== unresolvedCount(b.host)) {
              return unresolvedCount(b.host) - unresolvedCount(a.host);
            }
            return nameCmp(a.host, b.host);
          case 'unresolvedCount:asc':
            if (unresolvedCount(a.host) !== unresolvedCount(b.host)) {
              return unresolvedCount(a.host) - unresolvedCount(b.host);
            }
            return nameCmp(a.host, b.host);
          default:
            if (a.openCount !== b.openCount) return b.openCount - a.openCount;
            return nameCmp(a.host, b.host);
        }
      }

      // Stable secondary sort: name asc on every comparator so two
      // tie-breaking rows (equal sort primary) land in deterministic
      // order. We do this by sorting `[host]` ascending first, then
      // calling `Array.prototype.sort` with the comparator above.
      // Apply the minimum to the completed host rollup. Filtering findings
      // before reduction would change a host's max score and its counts.
      // A threshold also excludes hosts with no score; zero remains valid
      // when the caller explicitly asks for minRiskScore=0.
      const trendFilteredRollups = presenceFilteredRollups.filter(([host]) =>
        matchesAssetRiskTrend(riskScoreChanges?.get(host) ?? null, riskTrend),
      );

      const sorted = trendFilteredRollups
        .sort(([aKey], [bKey]) => nameCmp(aKey, bKey))
        .sort(([, a], [, b]) => compare(a, b));

      const items = sorted.map(([, row]) => ({
        name: row.host,
        assetType: row.assetType,
        openCount: row.openCount,
        criticalCount: row.criticalCount,
        unresolvedCount: unresolvedCountByHost.get(row.host) ?? 0,
        highestUnresolvedSeverity: highestSeverityByHost.get(row.host) ?? null,
        riskScore: row.riskScore,
        lastActivityAt: (lastActivityByKey.get(row.host) ?? null)?.toISOString() ?? null,
        scanCount30d: scanIds30dByHost.get(row.host)?.size ?? 0,
      }));

      const start = (page - 1) * pageSize;
      const sliced = items.slice(start, start + pageSize);
      const displayedHosts = sliced.map((item) => item.name);
      const displayedRiskScoreChanges =
        riskScoreChanges ?? (await loadAssetRiskChanges(workspaceId, displayedHosts));
      const enrichedItems = sliced.map((item) => ({
        ...item,
        riskScoreChange: displayedRiskScoreChanges.get(item.name) ?? null,
        ...serializeLatestAssetScan(latestScanByHost.get(item.name)),
      }));
      return NextResponse.json(AssetList.parse({ items: enrichedItems, total: items.length }));
    } catch {
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  });
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'GET' } },
  );
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
