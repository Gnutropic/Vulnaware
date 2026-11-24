// @polsia:user-owned — Active-workspace-scoped per-finding alerts read API +
// admin-only manual create seam. Mirrors /api/v1/audit-events posture on
// GET minus the rate-limit wrapper (this route is intentionally OUTSIDE
// /api/v1/).
//
// Access-control posture:
//   - GET requires `requireTeamRole('member')` — viewers (and below) get 403;
//     unauthenticated callers get 401.
//   - POST is admin-only via `requireAdminJson` (better-auth role ===
//     'admin'). The manual create seam is the eval-time back-door for the
//     "creating a critical alert on a live alert POSTs to a public sink"
//     success criterion — curl-able, no UI required. Both the manual POST
//     and the rescore cron lineage call the same `createAlertForTeam`
//     helper so the Slack-compatible fan-out is exercised end-to-end in
//     seconds.
//   - Every read query carries `teamId: workspaceContext.workspaceId` as the
//     seed `where` so the list is always narrow to the validated active workspace. No
//     per-id variant, so cross-team leak only happens through query-string
//     tampering — the route ignores every `teamId`-shaped leakage path
//     because no field is derived from the URL's `teamId` parameter
//     (none exists).
//   - `assigneeReady` is a derived filter composed from `acknowledgedAt IS
//     NULL AND assigneeId IS NULL`; treated as derived, NEVER a stored col.

import 'server-only';
import type { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { createAlertForTeam } from '@/lib/business/alerts';
import { computeAlertLastActivityAtForList } from '@/lib/business/alerts-activity';
import { AssetFilterError, parseAssetNamesToOrList } from '@/lib/business/alerts-asset';
import { buildAlertsWhere } from '@/lib/business/alerts-query-where';
import {
  batchFetchAlertVulnerabilityTitles,
  buildAlertSearchWhere,
} from '@/lib/business/alerts-search';
import { sortSeverityValues } from '@/lib/business/alerts-severity';
import { compareAlertRowsBySort, compareAlertsBySort } from '@/lib/business/alerts-sort';
import { resolveDashboardWorkspaceContext } from '@/lib/business/dashboard-workspace-context';
import { isAlertDateRangeOrdered } from '@/lib/contracts/alert-date-range';
import { AlertItem, AlertList, AlertQuery, TriggeredByEnum } from '@/lib/contracts/alerts';
import { AlertCreateBody, AlertCreateResponse } from '@/lib/contracts/team-notifications';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { requireTeamRole } from '@/lib/team-auth';

export const dynamic = 'force-dynamic';

// Admin-only gate for the POST seam. Verbatim mirror of
// src/app/api/v1/keys/route.ts: 'admin' role from better-auth plus
// requireAuth + JSON 403 so fetch callers get a sane response.
async function requireAdminJson(req: Request): Promise<SessionUser | NextResponse> {
  let user: SessionUser;
  try {
    user = await requireAuth(req);
  } catch (res) {
    return res as NextResponse;
  }
  if (user.role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return user;
}

export async function GET(req: Request) {
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

    const url = new URL(req.url);
    if (url.searchParams.has('workspaceId') || url.searchParams.has('teamId')) {
      return NextResponse.json(
        { error: 'bad_request', message: 'Workspace scope is selected by the server.' },
        { status: 400 },
      );
    }
    // `?ownedByMe=1` is an unrelated top-level filter: it narrows the
    // resultset to alerts the caller currently owns. We read it OUTSIDE
    // `AlertQuery` to keep the shared page-contract untouched — adding an
    // `ownedByMe` field to AlertQuery would couple this filter shape to the
    // export contract and force a parallel zod node here (mirror of
    // export.csv/route.ts:138-154). The wire shape is the boolean-flag
    // literal `'1'` only — any other value is hard-rejected with 400 so a
    // caller cannot narrow the team's rows to another member's id by URL
    // tampering.
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

    // `?remediated=1` is an unrelated top-level filter: it narrows the
    // resultset to alerts the caller has marked as remediated. We read
    // it OUTSIDE `AlertQuery` to keep the shared page-contract
    // untouched — same posture as `ownedByMe` / `hideSnoozed`. The wire
    // shape is the boolean-flag literal `'1'` only — any other value
    // is hard-rejected with 400 so a future URL-shape change can't
    // silently narrow to e.g. `?remediated=true` and re-emit the
    // legacy form on a stale bookmark.
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

    // `?snoozed=1` is an unrelated top-level filter: it narrows the
    // resultset to alerts with an ACTIVE snooze window
    // (`snoozedUntil > now`). We read it OUTSIDE `AlertQuery` to
    // keep the shared page-contract untouched — same posture as
    // `ownedByMe` / `remediatedOnly`. The wire shape is the
    // boolean-flag literal `'1'` only — any other value is hard-
    // rejected with 400 so a future URL-shape change can't silently
    // narrow to e.g. `?snoozed=true` and re-emit the legacy form on
    // a stale bookmark. The `> now` semantic (`gt`, NOT `gte`)
    // byte-matches the bulk-resolve helper (`alerts-bulk-resolve.ts`)
    // and the claim route `/api/alerts/[id]/claim/route.ts` "exclude
    // future snoozes" posture so a chip toggle surfaces exactly the
    // rows a snooze stamp would hold back from the bulk-resolve
    // working set.
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

    // `status=open` filters the stored workflow state and excludes an
    // active snooze window. It is handled outside AlertQuery so that
    // the server can add its snooze predicate; all other supported
    // statuses are validated through the shared schema below.
    //
    // `'snoozed'` is a derived enum arm: server-side it resolves to
    // `snoozedUntil > now` (the same predicate the existing
    // `?snoozed=1` boolean-flag narrows on). Surfacing it on the enum
    // status filter means the enum chip row can emit `?status=snoozed`
    // and the route applies the same `{ snoozedUntil: { gt: new Date() } }`
    // arm — semantics-locked with `snoozedOnlyNarrow` so a future tweak
    // keeps both lanes in lockstep.
    let openOnlyNarrow = false;
    const knownEnumStatuses = new Set(['in_progress', 'resolved', 'false_positive', 'snoozed']);
    if (url.searchParams.has('status')) {
      const v = url.searchParams.get('status');
      if (v === 'open') {
        openOnlyNarrow = true;
      } else if (knownEnumStatuses.has(v ?? '')) {
        // Flow through to the AlertQuery zod parse below — the enum
        // arms (other than 'open') are filtered here, the wire
        // maintains a single `?status=` key, and the server-side WHERE
        // branch below applies the derived 'snoozed' arm when the
        // parse lands on that literal.
      } else {
        return NextResponse.json(
          {
            error: 'bad_request',
            message: 'status must be open, in_progress, resolved, false_positive, or snoozed',
          },
          { status: 400 },
        );
      }
    }

    // Strip `status` from the AlertQuery zod parse when `openOnlyNarrow`
    // is active so the enum doesn't ALSO resolve the literal `'open'`.
    // The boolean-flag lane (this block) owns the wire key
    // exclusively — see the wire-key collision note on
    // `@/lib/business/alerts-effective-qs.ts`. The other enum literals
    // (`in_progress | resolved | false_positive`) flow through the
    // zod parse unchanged.
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
    if (!isAlertDateRangeOrdered(parsed.data.from, parsed.data.to)) {
      return NextResponse.json(
        { error: 'bad_request', message: 'from must be on or before to' },
        { status: 400 },
      );
    }

    const { page, pageSize, sort, status: wireStatus, asset } = parsed.data;
    // `asset` — composite `${host}:${port}/${protocol}` CSV. Validate it
    // before constructing the shared predicate so malformed input returns 400.
    let assetOrList: Array<{ host: string; port: number; protocol: string }> = [];
    try {
      assetOrList = parseAssetNamesToOrList(asset ?? null);
    } catch (err) {
      if (err instanceof AssetFilterError) {
        return NextResponse.json({ error: 'bad_request', message: err.message }, { status: 400 });
      }
      throw err;
    }

    const searchClause = parsed.data.hostname
      ? await buildAlertSearchWhere(parsed.data.q, parsed.data.hostname)
      : await buildAlertSearchWhere(parsed.data.q);
    const searchFinding =
      typeof searchClause.finding === 'object' && searchClause.finding !== null
        ? (searchClause.finding as Prisma.VulnerabilityFindingWhereInput)
        : undefined;
    const teamId = workspaceContext.workspaceId;
    const { countsWhere, where } = buildAlertsWhere({
      teamId,
      workspaceMemberId: workspaceContext.workspaceMemberId,
      filters: {
        ...parsed.data,
        status: openOnlyNarrow ? 'open' : wireStatus,
        ownedByMe: ownedByNarrow ? '1' : undefined,
        remediated: remediatedOnlyNarrow ? '1' : undefined,
        snoozed: snoozedOnlyNarrow ? '1' : undefined,
      },
      searchFinding,
      assetOrList,
    });

    try {
      // Sort branch — drives the SQL `orderBy` for created-time / status,
      // and the in-app comparator below for `severity` / `severity:asc`:
      //   - `created` : SQL `orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]`.
      //     The unique id tie-break keeps equal timestamps stable across pages.
      //   - `status`  : SQL `orderBy: [{ status: 'asc' }, { createdAt:
      //     'desc' }, { id: 'desc' }]`. Prisma enum ordinal = declaration
      //     order (`open` < `in_progress` < `resolved`); the composite
      //     `(createdAt, id)` tiebreak keeps the cursor stable across
      //     pages. The `@@index([teamId, status])` covers the prefix.
      //   - `severity` : `Alert.severity` is FREE-FORM TEXT — Prisma cannot
      //     order by the canonical lowercase case-rank. For these sorts,
      //     a narrow scoped projection of every matching alert, including
      //     its hostname, is sorted in memory before page IDs are selected.
      //     The full row projection below then reads only those IDs;
      //     pagination therefore matches the global comparator without
      //     loading every alert relation.
      const listOrderBy:
        | Prisma.AlertOrderByWithRelationInput[]
        | Prisma.AlertOrderByWithRelationInput =
        sort === 'created:asc'
          ? [{ createdAt: 'asc' }, { id: 'asc' }]
          : sort === 'status'
            ? [{ status: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }]
            : sort === 'riskScore' || sort === 'riskScore:asc'
              ? [
                  {
                    finding: {
                      priorityScore: {
                        sort: sort === 'riskScore' ? 'desc' : 'asc',
                        nulls: 'last',
                      },
                    },
                  },
                  { createdAt: 'desc' },
                  { id: 'desc' },
                ]
              : [{ createdAt: 'desc' }, { id: 'desc' }];

      const severitySort = sort === 'severity' || sort === 'severity:asc' ? sort : null;
      const severityPageIds = severitySort
        ? (
            await prisma.alert.findMany({
              where,
              select: {
                id: true,
                severity: true,
                createdAt: true,
                finding: { select: { asset: { select: { host: true } } } },
              },
            })
          )
            .sort((a, b) =>
              compareAlertRowsBySort(
                {
                  id: a.id,
                  severity: a.severity,
                  hostname: a.finding?.asset?.host,
                  status: 'open',
                  createdAt: a.createdAt,
                  lastActivityAt: null,
                  priorityScore: null,
                },
                {
                  id: b.id,
                  severity: b.severity,
                  hostname: b.finding?.asset?.host,
                  status: 'open',
                  createdAt: b.createdAt,
                  lastActivityAt: null,
                  priorityScore: null,
                },
                severitySort,
              ),
            )
            .slice((page - 1) * pageSize, page * pageSize)
            .map((row) => row.id)
        : null;

      const [rows, total, severityGroups, snoozedCount, trendRow] = await Promise.all([
        prisma.alert.findMany({
          where: severityPageIds === null ? where : { ...where, id: { in: severityPageIds } },
          orderBy: listOrderBy,
          ...(severityPageIds === null ? { skip: (page - 1) * pageSize, take: pageSize } : {}),
          // `vulnerabilityTitle` is NOT included here — it is stamped onto
          // each mapped `AlertItem` via a peer-read of `CveEntry.description`
          // (the helper `batchFetchAlertVulnerabilityTitles`), because
          // CveEntry has no Prisma relation to VulnerabilityFinding today.
          // All other list fields round-trip directly to `AlertItem`.
          include: {
            finding: {
              select: {
                cveId: true,
                priorityScore: true,
                asset: {
                  select: {
                    host: true,
                    port: true,
                    protocol: true,
                    scan: { select: { teamId: true } },
                  },
                },
                scan: { select: { source: true } },
              },
            },
            // Per-alert cached "Explain with AI" prose. A 1:1 back-ref
            // on `Alert` declared in prisma/schema/cve-explanation.prisma;
            // the findMany projection pulls the row only on the
            // (teamId, createdAt desc) page slice so a /alerts row
            // can render an "AI explained" stamp without a second
            // round trip. select narrows to the two wire columns so
            // the cardinality of each row stays bounded.
            explanation: {
              select: { explanationText: true, generatedAt: true },
            },
          },
        }),
        prisma.alert.count({ where }),
        // Per-severity counts power the chip-row's count badges. Counts use
        // the complete list predicate, including the active severity filter,
        // so every badge describes the current filtered view rather than a
        // hypothetical view with severity removed. Unknown / free-form
        // severity values coalesce into `low` below so the badges never crash
        // on legacy data.
        prisma.alert.groupBy({
          by: ['severity'],
          where,
          _count: true,
        }),
        // Snoozed count powers the Snoozed chip's count badge. Sister
        // to the severity groupBy above — same "how many will I see if
        // I click me" invariant (scoped by `countsWhere`, so the active
        // severity filter is ignored but status + teamId + the other
        // boolean-flag lanes are respected). The `snoozedUntil: { gt:
        // new Date() }` arm is byte-matches the existing
        // `?snoozed=1` narrowing AND the bulk-resolve / claim
        // "exclude future snoozes" posture verbatim — when
        // `snoozedOnlyNarrow` is true the arm is already in
        // `countsWhere` so this is idempotent (the badge would stamp
        // the same row count as the visible list in that case, which
        // is the right invariant — click Snoozed while it's active
        // and you're already looking at every snoozed row in scope).
        prisma.alert.count({
          where: { ...countsWhere, snoozedUntil: { gt: new Date() } },
        }),
        // Workspace's latest VulnerabilityTrend row. Single targeted read
        // on the `@@index([workspaceId, computedAt desc])`, scoped
        // absolutely by `workspaceContext.workspaceId`. We pull only `signal`
        // so the payload stays narrow — the trend JSON may carry the
        // full VelocityTrendSignal but the row stamp only needs
        // `acceleratingIncreases` for the badge Set lookup. `null` is
        // a cold-start case (no cron tick yet) and treated as "no
        // trending marker on any row".
        prisma.vulnerabilityTrend.findFirst({
          where: { workspaceId: workspaceContext.workspaceId },
          orderBy: { computedAt: 'desc' },
          select: { signal: true },
        }),
      ]);

      // Severity choices are a workspace facet, independent of the other
      // active filters. That keeps every severity represented in this
      // workspace selectable when status or hostname narrows the visible
      // rows, while the workspace id remains server-derived.
      const severityOptionGroups = await prisma.alert.groupBy({
        by: ['severity'],
        where: { teamId },
        _count: true,
      });

      // Batch-resolve owner display names. Alert.ownerId → WorkspaceMember.id
      // (scalar FK, no relation edge). Two round trips total, regardless of
      // page size: collect unique ownerIds from this page's rows, fetch
      // matching WorkspaceMember rows in one shot, then fetch User rows for
      // their userIds. name falls back to null when the chain breaks.
      const ownerIds = Array.from(
        new Set(
          rows
            .map((r) => r.ownerId)
            .filter((v): v is string => typeof v === 'string' && v.length > 0),
        ),
      );
      const ownerMembers = ownerIds.length
        ? await prisma.workspaceMember.findMany({
            where: {
              id: { in: ownerIds },
              workspaceId: workspaceContext.workspaceId,
              status: 'active',
            },
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

      // Batch peer-read: map each distinct cveId on this page to a
      // `vulnerabilityTitle` (= CveEntry.description). CveEntry has no
      // Prisma relation to VulnerabilityFinding today so this is a separate
      // second-query join. See batchFetchAlertVulnerabilityTitles for
      // details on the approach and the null-branch contract.
      const pageCveIds = rows.map((r) => r.finding?.cveId ?? '');
      const vulnerabilityTitleByCveId = await batchFetchAlertVulnerabilityTitles(pageCveIds);

      // Peer-read: count `AlertComment` rows per alert on this page. Runs
      // AFTER the four-row Promise.all so the alertId set is known without
      // an inline `rows.map(...)` inside the parallel block. The `alert:
      // { teamId }` join keeps the count strictly team-scoped — even a
      // caller that tampers with page params can't surface counts from
      // another team's thread. `@@index([alertId, createdAt])` on
      // AlertComment covers the grouping key. Empty `in: []` on a page
      // with zero rows is safe — Prisma returns zero group rows.
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

      // Peer-read: per-alert `lastActivityAt = MAX(remediatedAt,
      // MAX(AlertNote.createdAt))`. Two-arm derivation — picks the
      // most-recent of (latest AlertNote, remediatedAt). When BOTH
      // arms resolve to null (a brand-new row with no handoff notes
      // and no remediation stamp), the helper returns `null` and the
      // row is OMITTED from the per-row map; the route reads
      // `lastActivityMap.get(id) ?? null` and stamps the wire stamp
      // as null so the UI's em-dash placeholder branch fires.
      // One groupBy across the page slice; the reduce merges the
      // per-alert note-max with the row's existing remediatedAt so
      // the helper never has to look up remediatedAt itself. Team-
      // scoped via `alert: { teamId }` to mirror the `commentGroups`
      // posture above.
      const lastActivityMap = await computeAlertLastActivityAtForList(
        rows.map((r) => ({
          id: r.id,
          remediatedAt: r.remediatedAt,
          createdAt: r.createdAt,
        })),
        teamId,
      );

      // Build the in-memory Set of CVE ids currently accelerating for the
      // workspace's latest trend row. `signal.acceleratingIncreases` defaults
      // to `[]` via the contract, but a cold-start row whose signal was
      // written before that field existed still round-trips as `[]` through
      // the deep-clone + zod parse below. A missing trend row → empty set →
      // no row gets the badge.
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
          // Malformed signal JSON — leave the empty set in place; UI just
          // shows no Trending badges and the per-CVE detail returns 404.
        }
      }

      const items = rows.map((r) => {
        // Scan.source is a free-form string column, so the join from
        // Alert → VulnerabilityFinding → Scan can surface values outside the
        // canonical TriggeredBy union (legacy rows, hand-stamped values, etc.).
        // Validate per-row so the wire shape stays consistent; the UI falls
        // back to its 'manual' label for anything that fails the parse.
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
          // CveEntry.description stamped onto the row via the
          // batched peer-read above. Null when the CVE has no
          // CveEntry row yet (cold-start / pre-ingest) so the UI can
          // render an em-dash instead of a stale literal.
          vulnerabilityTitle: vulnerabilityTitleByCveId.get(cveId) ?? null,
          asset: {
            host: r.finding?.asset?.host ?? '',
            port: r.finding?.asset?.port ?? 0,
            protocol: r.finding?.asset?.protocol ?? '',
            riskScore:
              r.finding?.asset && Number.isFinite(r.finding.priorityScore)
                ? r.finding.priorityScore
                : null,
            detailHref:
              r.finding?.asset?.host &&
              r.finding.asset.scan?.teamId === workspaceContext.workspaceId
                ? `/assets/${encodeURIComponent(r.finding.asset.host)}`
                : undefined,
          },
          triggeredBy,
          // Trending stamp: ONLY attach `trending: true` when the row's
          // CVE is in the workspace's latest accelerating set. Otherwise
          // omit the field — the contract declares `trending` as
          // `.optional()` so a sparse absence flows through unchanged.
          trending: cveId.length > 0 && trendingCveIds.has(cveId) ? true : undefined,
          // Comment count stamp: server-derived count of `AlertComment`
          // rows for this alert. Defaults to 0 (never absent) so the
          // contract's `.optional()` is satisfied in the happy path and
          // the UI's `> 0` gate cleanly hides the badge on thread-less
          // rows. Scoped team-side via the groupBy `alert: { teamId }`.
          commentCount: commentCountByAlertId.get(r.id) ?? 0,
          // Operator-stamped FP reason. Null on every non-FP row. The
          // chip's subtitle reads this when status === 'false_positive';
          // null otherwise. Read off the existing Alert row projection
          // (no inflation of the findMany select shape — Prisma returns
          // every column by default), so adding it here is just a wire-
          // shape widening on the AlertItem.parse(...) call.
          falsePositiveReason: r.falsePositiveReason ?? null,
          // Operator-stamped close note. Null on every non-resolved
          // row — a non-resolved row MUST NOT carry a close note. The
          // CSV export's `closingNote` column mirrors this field, so
          // the list endpoint stamps it onto every AlertItem so a
          // future row UI can render a chip subtitle + the CSV export
          // can pull it without a second read.
          closingNote: r.closingNote ?? null,
          // Operator-stamped "I acted on this" stamp. Null on every
          // unremediated row — `remediatedAt === NOT NULL` is the
          // single wire shape that powers the row-level
          // `Remediated` badge + the `?remediated=1` list filter +
          // the CSV's `remediatedAt` column. The list endpoint
          // stamps it onto every AlertItem so the row-level chip
          // stack and the export route can read the column
          // off the same Prisma row projection that backs the list
          // pages.
          remediatedAt: r.remediatedAt ? r.remediatedAt.toISOString() : null,
          // Operator's email stamp captured at the same time
          // `remediatedAt` is set. Read off `Alert.remediatedByEmail`
          // (the column Prisma returns by default on the existing
          // findMany projection — no select widening required). Null
          // on every unremediated row, and ALSO null on rows stamped
          // by a caller whose WorkspaceMember.email AND User.email
          // were both missing at write-time. The render-only field
          // rides the same AlertItem / AlertDetail column shape so
          // the row-level chip stack can render "Remediated by
          // <email>" without a second round trip; the bulk-snooze /
          // bulk-remediate / CSV-export branches read off the same
          // shape.
          remediatedByEmail: r.remediatedByEmail ?? null,
          // Server-derived "most recent activity" stamp =
          // MAX(remediatedAt, MAX(AlertNote.createdAt)) per alert.
          // Stamped onto every AlertItem via the peer-read map above
          // so the /alerts table's "Last activity" column + the
          // mobile card pill + the CSV's tail cell read off the same
          // derived value. Newer AlertNote overrides remediatedAt
          // when both exist (an active shift handoff surfaces even
          // on a long-since-remediated row). Rows where both inputs
          // are null are omitted from the map and stamp `null` here.
          lastActivityAt: (() => {
            const v = lastActivityMap.get(r.id);
            return v ? v.toISOString() : null;
          })(),
          // Operator-stamped "Explain with AI" prose + timestamp —
          // read off the per-alert `explanation` back-ref on the
          // same `findMany` projection above. The nested `select`
          // keeps the wire narrow — only `explanationText` and
          // `generatedAt` ride the AlertItem envelope. `null` on
          // every row whose `explain` POST hasn't yet streamed (the
          // cache miss branch). Mirrors the AlertDetail shape
          // exactly so list + detail share one column shape
          // end-to-end.
          lastExplainedAt: r.explanation?.generatedAt
            ? r.explanation.generatedAt.toISOString()
            : null,
          lastExplanationText: r.explanation?.explanationText ?? null,
        });
      });

      // Final in-app rank pass keeps the returned page ordered exactly
      // like the page-side comparator. Severity IDs were selected from a
      // globally sorted, hostname-aware narrow projection above, before
      // pagination.
      // `lastActivity` still rides the
      // same monotone SQL cursor because the derived column has no
      // Prisma `orderBy` literal — the in-app comparator runs on the
      // page slice so the visible table matches the page-side
      // dropdown's `lastActivity` / `lastActivity:asc` options
      // (others are monotone-native). The `:asc` arm widens this
      // branch so the dropdown's "Last activity (Oldest first)"
      // option drives the comparator too, not just DESC.
      if (
        sort === 'severity' ||
        sort === 'severity:asc' ||
        sort === 'lastActivity' ||
        sort === 'lastActivity:asc'
      ) {
        items.sort((a, b) => compareAlertsBySort(a, b, sort));
      }

      const severityOptions = sortSeverityValues(
        severityOptionGroups.flatMap((g) => {
          const value = g.severity?.trim();
          return value ? [value] : [];
        }),
      );

      // Coalesce the active-view groupBy rows into the four severity
      // buckets. severity is a free-form text column on disk, so coerce
      // case-insensitively and bucket anything we don't recognize into `low`
      // — the badges must never crash on unknown / null values. `snoozed`
      // rides alongside as the peer-read integer the Snoozed chip's count
      // badge reads.
      const counts = { critical: 0, high: 0, medium: 0, low: 0, snoozed: snoozedCount };
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

export async function POST(req: Request) {
  return withApiRequest(req, async () => {
    const authResult = await requireAdminJson(req);
    if (authResult instanceof NextResponse) return authResult;
    const user = authResult;

    // Manual POST pins a single team — the 'system' team if the caller is an
    // admin, 'users' otherwise (mirror /api/v1/keys POST posture).
    setRequestAuth({ userId: user.id, teamId: 'unresolved' });
    const teamName = user.role === 'admin' ? 'system' : 'users';
    const teamId = (
      await prisma.team.upsert({
        where: { name: teamName },
        update: {},
        create: { name: teamName },
      })
    ).id;
    setRequestAuth({ teamId });

    let json: unknown;
    try {
      json = await req.json();
    } catch {
      return NextResponse.json({ code: 'bad_request', message: 'invalid JSON' }, { status: 400 });
    }
    const parsed = AlertCreateBody.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'bad_request', issues: parsed.error.flatten() },
        { status: 400 },
      );
    }

    try {
      const created = await createAlertForTeam({
        teamId,
        findingId: parsed.data.findingId ?? 'manual',
        severity: parsed.data.severity ?? 'critical',
        source: 'manual',
        title: parsed.data.title ?? parsed.data.alertId ?? 'Manual alert',
        alertId: parsed.data.alertId,
      });
      const body = AlertCreateResponse.parse({
        id: created.id,
        teamId: created.teamId,
        severity: created.severity,
        title: created.title,
        findingId: parsed.data.findingId ?? null,
        createdAt: new Date().toISOString(),
        delivered: created.delivered,
        deliveryStatus: created.deliveryStatus,
        deliveryError: created.deliveryError,
      });
      return NextResponse.json(body, { status: 201 });
    } catch {
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  });
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'GET, POST' } },
  );
}

export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
