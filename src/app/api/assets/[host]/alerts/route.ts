// @polsia:user-owned — Per-host alerts list for the /assets/[host] drill-
// down page. Mirror of src/app/api/alerts/route.ts with ONE extending
// clause:
//   - host narrowing: `finding: { ..., asset: { host: <pathParam> } }`
//     composes on top of the existing deep-merge so the route returns
//     exactly the alerts that contributed to the host's rollup on the
//     parent /assets page.
//
// Everything else is verbatim from /api/alerts: AlertQuery zod parse,
// the outside-AlertQuery flag lanes (ownedByMe / remediated / snoozed /
// open), the where composer with `rootOrArms` (snooze / since /
// assigneeReady=false), the four peer-reads (`AlertItem.ownerName` /
// `vulnerabilityTitle` / `commentCount` / `lastActivityAt`), the
// `compareAlertsBySort` re-rank, and the `AlertList.parse` envelope
// stamp. The wire shape is byte-for-byte identical to the /api/alerts
// envelope so the client island reads the response with the same
// `AlertList` schema the /alerts page already parses.
//
// Why mirror rather than share: the existing `/api/alerts` route is
// already ~700 lines; extracting a shared `composeAlertsWhere` +
// `fetchAlertListPage` helper would force every future contributor to
// follow a layered read across two files. The mirror-via-copy posture
// shared by `dashboard-top-assets.ts:loadTopAffectedAssets` +
// `assets/route.ts:loadAssetRollup` keeps each route's surface area
// self-contained, and the only semantic delta (the host narrowing
// clause) is a single composed `finding` key — a copy-edit rather than
// a refactor.
//
// Access-control posture: identical to /api/assets/[host] and
// /api/alerts. `requireTeamRole('member')` gates the call; the host
// path param is decoded, lowercased, trimmed, and validated through
// `AssetDetailPathParam` BEFORE any Prisma reads. The where clause
// also seeds `teamId` from the validated active workspace so a cross-team
// host probe returns an empty list (NOT a 404) — the same opaque
// posture /api/alerts already pins.
//
// URL safety:
//   - `host` is `decodeURIComponent`'d then `.toLowerCase().trim()`'d
//     before the Prisma `where` so a typed `/assets/Foo.Bar` resolves
//     to `foo.bar` (DNS is case-insensitive).
//   - `decodeURIComponent` is wrapped in try/catch so a malformed
//     `%E0%A4%A`-style escape returns 400 rather than crashing the route.
//   - The zod refine on `AssetDetailPathParam` rejects A-Z, 0-9, ":",
//     ".", "_", "-" only — anything else (a `/`, a space, an EM-DASH)
//     400s. Matches /api/assets/[host] verbatim so the two endpoints
//     can't drift on what counts as a malformed host.

import 'server-only';
import type { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { computeAlertLastActivityAtForList } from '@/lib/business/alerts-activity';
import {
  batchFetchAlertVulnerabilityTitles,
  buildAlertSearchWhere,
} from '@/lib/business/alerts-search';
import { parseSeverityFilter, sortSeverityValues } from '@/lib/business/alerts-severity';
import { sinceToBoundDate } from '@/lib/business/alerts-since';
import { compareAlertsBySort } from '@/lib/business/alerts-sort';
import { resolveDashboardWorkspaceContext } from '@/lib/business/dashboard-workspace-context';
import { AlertItem, AlertList, AlertQuery, TriggeredByEnum } from '@/lib/contracts/alerts';
import { AssetDetailPathParam } from '@/lib/contracts/assets-detail';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { requireTeamRole } from '@/lib/team-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ host: string }> }) {
  return withApiRequest(req, async () => {
    let ctx: Awaited<ReturnType<typeof requireTeamRole>>;
    try {
      ctx = await requireTeamRole('member');
    } catch (res) {
      return res as Response;
    }

    const workspaceContext = await resolveDashboardWorkspaceContext(ctx.user.id);
    if (!workspaceContext) {
      return NextResponse.json({ error: 'No active workspace' }, { status: 404 });
    }
    setRequestAuth({ userId: ctx.user.id, teamId: workspaceContext.workspaceId });

    // Step 0: decode + normalize + validate the path-param host.
    // Verbatim mirror of /api/assets/[host]/route.ts:50-64 — same
    // posture so a bad URL can't drift between the two endpoints.
    const rawParams = await params;
    let decodedHost: string;
    try {
      decodedHost = decodeURIComponent(rawParams.host);
    } catch {
      return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    }
    const normalizedHost = decodedHost.toLowerCase().trim();

    const hostParsed = AssetDetailPathParam.safeParse({ host: normalizedHost });
    if (!hostParsed.success) {
      return NextResponse.json(
        { error: 'bad_request', issues: hostParsed.error.flatten() },
        { status: 400 },
      );
    }

    const host = hostParsed.data.host;
    const url = new URL(req.url);

    // The following block — `ownedByNarrow`, `remediatedOnlyNarrow`,
    // `snoozedOnlyNarrow`, `openOnlyNarrow`, the AlertQuery zod parse,
    // the rescoping to `status`, the build of `countsWhere`, the
    // peer-reads, the in-app re-rank, the counts merging — is a
    // VERBATIM mirror of /api/alerts/route.ts. The ONLY post-copy
    // mutation is the host narrowing clause spliced INTO the existing
    // `finding:` deep-merge (see the `finding` arm below). Each line
    // is annotated with the source's location so a future contributor
    // reconciling the two endpoints can read the diff inline.

    // `?ownedByMe=1` — mirror of /api/alerts/route.ts:84-94.
    let ownedByNarrow = false;
    if (url.searchParams.has('ownedByMe')) {
      if (url.searchParams.get('ownedByMe') === '1') {
        ownedByNarrow = true;
      } else {
        return NextResponse.json(
          { error: 'bad_request', message: 'ownedByMe must be "1"' },
          { status: 400 },
        );
      }
    }

    // `?remediated=1` — mirror of /api/alerts/route.ts:104-114.
    let remediatedOnlyNarrow = false;
    if (url.searchParams.has('remediated')) {
      if (url.searchParams.get('remediated') === '1') {
        remediatedOnlyNarrow = true;
      } else {
        return NextResponse.json(
          { error: 'bad_request', message: 'remediated must be "1"' },
          { status: 400 },
        );
      }
    }

    // `?snoozed=1` — mirror of /api/alerts/route.ts:130-140.
    let snoozedOnlyNarrow = false;
    if (url.searchParams.has('snoozed')) {
      if (url.searchParams.get('snoozed') === '1') {
        snoozedOnlyNarrow = true;
      } else {
        return NextResponse.json(
          { error: 'bad_request', message: 'snoozed must be "1"' },
          { status: 400 },
        );
      }
    }

    // `?unresolved=1` — the asset detail summary's focused read. Keep this
    // as an explicit narrow rather than teaching AlertQuery a second
    // response shape so the existing all-lifecycle table stays unchanged.
    let unresolvedOnlyNarrow = false;
    if (url.searchParams.has('unresolved')) {
      if (url.searchParams.get('unresolved') === '1') {
        unresolvedOnlyNarrow = true;
      } else {
        return NextResponse.json(
          { error: 'bad_request', message: 'unresolved must be "1"' },
          { status: 400 },
        );
      }
    }

    // `?status=open | in_progress | resolved | false_positive | snoozed` —
    // mirror of /api/alerts/route.ts:174-196.
    let openOnlyNarrow = false;
    const knownEnumStatuses = new Set(['in_progress', 'resolved', 'false_positive', 'snoozed']);
    if (url.searchParams.has('status')) {
      const v = url.searchParams.get('status');
      if (v === 'open') {
        openOnlyNarrow = true;
      } else if (knownEnumStatuses.has(v ?? '')) {
        // Flow through to the AlertQuery zod parse below.
      } else {
        return NextResponse.json(
          {
            error: 'bad_request',
            message:
              '?status=open is the boolean-flag filter; use ?status=in_progress|resolved|false_positive|snoozed for the enum',
          },
          { status: 400 },
        );
      }
    }

    // Strip `status` from the AlertQuery zod parse when `openOnlyNarrow`
    // is active so the enum doesn't ALSO resolve the literal `'open'`.
    // Mirror of /api/alerts/route.ts:205-215.
    const rawQuery = Object.fromEntries(url.searchParams.entries());
    if (openOnlyNarrow) {
      delete (rawQuery as Record<string, unknown>).status;
    }
    const parsed = AlertQuery.safeParse(rawQuery);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'bad_request', issues: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const {
      severity,
      source,
      triggeredBy,
      status: wireStatus,
      acknowledged,
      assigneeReady,
      hideSnoozed,
      q,
      from,
      to,
      since,
      page,
      pageSize,
      sort,
    } = parsed.data;
    // `status` local rebind for the spread literal — drop the derived
    // `'snoozed'` arm so Prisma never sees it on the column.
    const status: 'open' | 'in_progress' | 'resolved' | 'false_positive' | undefined =
      wireStatus === 'snoozed' || wireStatus == null ? undefined : wireStatus;
    const severityIn = parseSeverityFilter(severity ?? null);
    const teamId = workspaceContext.workspaceId;

    // Intersect the unresolved narrow with an explicit status filter instead
    // of allowing a conflicting lifecycle filter to broaden the result. An
    // empty `in` arm produces a valid, row-free Prisma predicate for a
    // conflict such as `unresolved=1&status=resolved`.
    const statusWhere = unresolvedOnlyNarrow
      ? openOnlyNarrow
        ? { status: 'open' as const }
        : status === 'in_progress'
          ? { status: 'in_progress' as const }
          : status
            ? { status: { in: [] as ('open' | 'in_progress')[] } }
            : { status: { in: ['open', 'in_progress'] as ('open' | 'in_progress')[] } }
      : openOnlyNarrow
        ? { status: 'open' as const }
        : status
          ? { status }
          : {};

    // Hide-snooze arms — mirror of /api/alerts/route.ts:284-285.
    const snoozeArms: Array<Record<string, unknown>> =
      hideSnoozed === '1' ? [{ snoozedUntil: null }, { snoozedUntil: { lte: new Date() } }] : [];

    // Pre-resolved `q` search clause — mirror of /api/alerts/route.ts:293.
    const searchClause = await buildAlertSearchWhere(q);

    // `?since=` chip arms — mirror of /api/alerts/route.ts:301-306.
    const sinceArms: Array<Record<string, unknown>> = since
      ? (() => {
          const bound = sinceToBoundDate(since);
          return [{ createdAt: { gte: bound } }, { statusChangedAt: { gte: bound } }];
        })()
      : [];

    // Assignee-ready false arms — mirror of /api/alerts/route.ts:311-314.
    const assigneeReadyFalseArms: Array<Record<string, unknown>> =
      assigneeReady === false
        ? [{ acknowledgedAt: { not: null } }, { assigneeId: { not: null } }]
        : [];

    // Compose all top-level OR arms — mirror of /api/alerts/route.ts:321-325.
    const rootOrArms: Array<Record<string, unknown>> = [
      ...snoozeArms,
      ...sinceArms,
      ...assigneeReadyFalseArms,
    ];

    // countsWhere — extends /api/alerts/route.ts:327-442 with a host
    // narrowing clause spliced into the existing `finding` deep-merge
    // (see below — the host narrowing goes WHERE the asset OR-list
    // already lives, so JS shallow-spread footgun is preserved).
    const countsWhere = {
      teamId,
      ...(source ? { source } : {}),
      // Status + snooze/aux arm — mirror of /api/alerts/route.ts:353-366.
      ...(openOnlyNarrow
        ? {
            ...statusWhere,
            OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: new Date() } }],
          }
        : wireStatus === 'snoozed'
          ? {
              ...statusWhere,
              snoozedUntil: { gt: new Date() },
              ...(rootOrArms.length > 0 ? { OR: rootOrArms } : {}),
            }
          : {
              ...statusWhere,
              ...(rootOrArms.length > 0 ? { OR: rootOrArms } : {}),
            }),
      ...(acknowledged === true ? { acknowledgedAt: { not: null } } : {}),
      ...(acknowledged === false ? { acknowledgedAt: null } : {}),
      ...(assigneeReady === true ? { acknowledgedAt: null, assigneeId: null } : {}),
      // ──────────────────────────────────────────────────────────────────
      // HOST NARROWING (the only post-mirror mutation in this route):
      // `triggeredBy` + `q` + the host narrowing all narrow inside
      // `finding.*`. Each owns a distinct sibling key (`scan`, the
      // search helper's `searchClause.finding`, and `asset.host` for
      // the per-host drill-down page), so they compose cleanly only
      // if we BUILD the nested `finding` object once instead of
      // spreading two separate ones. JS object spread is shallow,
      // so a second `finding:` literal would replace the first and
      // silently drop `triggeredBy` whenever a `q` is also active.
      //
      // The `host` key lands under `finding.asset.host` and is the
      // SINGLE narrowing applied on top of /api/alerts. `parsed.host`
      // is server-side normalized (lowercased + trimmed + regex-
      // validated via AssetDetailPathParam), so a tampered path-
      // segment can't bypass the chip-row filter chain. The route
      // does NOT derive host from `q` — a free-text substring on
      // `Asset.host` is a distinct query and stays live through
      // `searchClause` (so a /assets[host]/alerts?q= substring
      // narrows further without losing the path-param host lock).
      // ──────────────────────────────────────────────────────────────────
      ...(triggeredBy || q
        ? {
            finding: {
              ...(triggeredBy ? { scan: { source: triggeredBy } } : {}),
              ...(typeof searchClause.finding === 'object' && searchClause.finding !== null
                ? searchClause.finding
                : {}),
              // The host narrowing — composes on top of any
              // `searchClause.finding.asset` clause so a typed `q`
              // host substring ANDS the path-param host rather
              // than overriding it.
              asset: { host },
            },
          }
        : {
            // No `triggeredBy` or `q` active — build the `finding`
            // key with the host narrowing alone. Distinct arm so we
            // can omit the `triggeredBy` / `q` lookups entirely;
            // the existing /api/alerts asset OR-list arm is dropped
            // (the per-host drill-down always knows its host, so
            // there's no need to fan out via the composite
            // `${host}:${port}/${protocol}` CSV).
            finding: { asset: { host } },
          }),
      // `from` / `to` inclusive bounds — mirror of /api/alerts/route.ts:409-416.
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: new Date(from as string) } : {}),
              ...(to ? { lte: new Date(to as string) } : {}),
            },
          }
        : {}),
      // `?ownedByMe=1` — mirror of /api/alerts/route.ts:421.
      ...(ownedByNarrow
        ? {
            ownerId: {
              in: workspaceContext.workspaceMemberId ? [workspaceContext.workspaceMemberId] : [],
            },
          }
        : {}),
      // `?remediated=1` — mirror of /api/alerts/route.ts:429.
      ...(remediatedOnlyNarrow ? { remediatedAt: { not: null } } : {}),
      // `?snoozed=1` — mirror of /api/alerts/route.ts:441.
      ...(snoozedOnlyNarrow ? { snoozedUntil: { gt: new Date() } } : {}),
    };

    const where = {
      ...countsWhere,
      ...(severityIn.length > 0 ? { severity: { in: severityIn } } : {}),
    };

    try {
      // Sort branch — mirror of /api/alerts/route.ts:472-477.
      const listOrderBy:
        | Prisma.AlertOrderByWithRelationInput[]
        | Prisma.AlertOrderByWithRelationInput =
        sort === 'status'
          ? [{ status: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }]
          : { createdAt: 'desc' };

      // Parallel peer-read query (5 reads) — mirror of
      // /api/alerts/route.ts:479-550.
      const [rows, total, severityGroups, snoozedCount, trendRow] = await Promise.all([
        prisma.alert.findMany({
          where,
          orderBy: listOrderBy,
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: {
            finding: {
              select: {
                cveId: true,
                asset: { select: { host: true, port: true, protocol: true } },
                scan: { select: { source: true } },
              },
            },
            explanation: {
              select: { explanationText: true, generatedAt: true },
            },
          },
        }),
        prisma.alert.count({ where }),
        prisma.alert.groupBy({
          by: ['severity'],
          where: countsWhere,
          _count: true,
        }),
        prisma.alert.count({
          where: { ...countsWhere, snoozedUntil: { gt: new Date() } },
        }),
        prisma.vulnerabilityTrend.findFirst({
          where: { workspaceId: workspaceContext.workspaceId },
          orderBy: { computedAt: 'desc' },
          select: { signal: true },
        }),
      ]);

      // Owner name batch peer-read — mirror of /api/alerts/route.ts:557-588.
      const ownerIds = Array.from(
        new Set(
          rows
            .map((r) => r.ownerId)
            .filter((v): v is string => typeof v === 'string' && v.length > 0),
        ),
      );
      const ownerMembers = ownerIds.length
        ? await prisma.workspaceMember.findMany({
            where: { id: { in: ownerIds }, status: 'active' },
            select: { id: true, userId: true },
          })
        : [];
      const memberUserIds = Array.from(
        new Set(
          ownerMembers
            .map((m) => m.userId)
            .filter((v): v is string => typeof v === 'string' && v.length > 0),
        ),
      );
      const ownerUsers = memberUserIds.length
        ? await prisma.user.findMany({
            where: { id: { in: memberUserIds } },
            select: { id: true, name: true },
          })
        : [];
      const userById = new Map(ownerUsers.map((u) => [u.id, u.name ?? null] as const));
      const ownerNameByMemberId = new Map(
        ownerMembers.map(
          (m) => [m.id, m.userId ? (userById.get(m.userId) ?? null) : null] as const,
        ),
      );

      // Vulnerability title batch peer-read — mirror of /api/alerts/route.ts:591-596.
      const pageCveIds = rows.map((r) => r.finding?.cveId ?? '');
      const vulnerabilityTitleByCveId = await batchFetchAlertVulnerabilityTitles(pageCveIds);

      // Comment count peer-read — mirror of /api/alerts/route.ts:606-616.
      const commentGroups = await prisma.alertComment.groupBy({
        by: ['alertId'],
        where: {
          alertId: { in: rows.map((r) => r.id) },
          alert: { teamId },
        },
        _count: { _all: true },
      });
      const commentCountByAlertId = new Map(
        commentGroups.map((g) => [g.alertId, g._count._all] as const),
      );

      // Last activity peer-read — mirror of /api/alerts/route.ts:631-638.
      const lastActivityMap = await computeAlertLastActivityAtForList(
        rows.map((r) => ({
          id: r.id,
          remediatedAt: r.remediatedAt,
          createdAt: r.createdAt,
        })),
        teamId,
      );

      // Trend signal set — mirror of /api/alerts/route.ts:646-662.
      const trendingCveIds = new Set<string>();
      if (trendRow && trendRow.signal != null) {
        try {
          const signalPlain = JSON.parse(JSON.stringify(trendRow.signal)) as {
            acceleratingIncreases?: unknown;
          };
          const parsed = signalPlain?.acceleratingIncreases;
          if (Array.isArray(parsed)) {
            for (const v of parsed) {
              if (typeof v === 'string' && v.length > 0) trendingCveIds.add(v);
            }
          }
        } catch {
          // Malformed signal JSON — leave the empty set in place.
        }
      }

      // Build the AlertItem envelope — mirror of /api/alerts/route.ts:664-775.
      const items = rows.map((r) => {
        const rawSource = r.finding?.scan?.source ?? null;
        const triggeredByResult =
          rawSource == null ? undefined : TriggeredByEnum.safeParse(rawSource);
        const triggeredBy = triggeredByResult?.success ? triggeredByResult.data : undefined;
        const cveId = r.finding?.cveId ?? '';
        return AlertItem.parse({
          id: r.id,
          teamId: r.teamId,
          findingId: r.findingId,
          severity: r.severity ?? null,
          status: r.status,
          source: r.source,
          assigneeId: r.assigneeId ?? null,
          ownerId: r.ownerId ?? null,
          ownerName: r.ownerId ? (ownerNameByMemberId.get(r.ownerId) ?? null) : null,
          createdAt: r.createdAt.toISOString(),
          acknowledgedAt: r.acknowledgedAt ? r.acknowledgedAt.toISOString() : null,
          snoozedUntil: r.snoozedUntil ? r.snoozedUntil.toISOString() : null,
          cveId,
          vulnerabilityTitle: vulnerabilityTitleByCveId.get(cveId) ?? null,
          asset: {
            host: r.finding?.asset?.host ?? '',
            port: r.finding?.asset?.port ?? 0,
            protocol: r.finding?.asset?.protocol ?? '',
          },
          triggeredBy,
          trending: cveId.length > 0 && trendingCveIds.has(cveId) ? true : undefined,
          commentCount: commentCountByAlertId.get(r.id) ?? 0,
          falsePositiveReason: r.falsePositiveReason ?? null,
          closingNote: r.closingNote ?? null,
          remediatedAt: r.remediatedAt ? r.remediatedAt.toISOString() : null,
          remediatedByEmail: r.remediatedByEmail ?? null,
          lastActivityAt: (() => {
            const v = lastActivityMap.get(r.id);
            return v ? v.toISOString() : null;
          })(),
          lastExplainedAt: r.explanation?.generatedAt
            ? r.explanation.generatedAt.toISOString()
            : null,
          lastExplanationText: r.explanation?.explanationText ?? null,
        });
      });

      // In-app re-rank — mirror of /api/alerts/route.ts:793-795,
      // including both severity directions.
      if (
        sort === 'severity' ||
        sort === 'severity:asc' ||
        sort === 'lastActivity' ||
        sort === 'lastActivity:asc'
      ) {
        items.sort((a, b) => compareAlertsBySort(a, b, sort));
      }

      // Counts merging — mirror of /api/alerts/route.ts:804-811.
      const counts = { critical: 0, high: 0, medium: 0, low: 0, snoozed: snoozedCount };
      const severityOptions = sortSeverityValues(
        severityGroups.flatMap((g) => {
          const value = g.severity?.trim();
          return value ? [value] : [];
        }),
      );
      for (const g of severityGroups) {
        const key = (g.severity ?? '').toLowerCase();
        if (key === 'critical') counts.critical += g._count;
        else if (key === 'high') counts.high += g._count;
        else if (key === 'medium') counts.medium += g._count;
        else counts.low += g._count;
      }

      return NextResponse.json(
        AlertList.parse({ items, total, page, pageSize, counts, severityOptions }),
      );
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
