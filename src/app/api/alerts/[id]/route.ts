// @polsia:user-owned — Single-alert fetch by id. Used by /alerts/[id] page.
//
// Access-control posture mirrors /api/alerts (the list): GET requires an
// active WorkspaceMember in the selected workspace. The alert lookup is
// constrained by both id and the active workspace ID (legacy Alert.teamId),
// so a cross-workspace id and a missing row both resolve to the same 404.
//
// `CveEntry` join: VulnerabilityFinding.cveId is a free-form string column
// with NO Prisma relation to CveEntry today. We do an explicit
// `prisma.cveEntry.findUnique({ where: { cveId } })` second query. If the
// CVE row is absent (entry never ingested) we default to null/empty so the
// contract still validates rather than blowing up the parse.
//
// `lastSeen` for the affected-asset row is sourced from
// `VulnerabilityFinding.lastRescoreAt` because the Asset model has no
// lastSeen column. Today's contract renders ONE row per alert (the
// underlying finding's asset); expansion to "every finding the team owns
// for this CVE" is a future query — see Risks in the brief.
//
// `ownerName` resolution: Alert.ownerId is a scalar FK into
// `WorkspaceMember.id` (no Prisma relation edge). Doing the
// `WorkspaceMember → User` join in app code matches every other
// cross-model link in this repo. Two extra lookups per detail page,
// primary key — cheap.

import 'server-only';
import { NextResponse } from 'next/server';
import { requireAlertWorkspaceMember } from '@/lib/business/alert-workspace-access';
import { computeAlertLastActivityAtForOne } from '@/lib/business/alerts-activity';
import { AlertDetail as AlertDetailSchema, TriggeredByEnum } from '@/lib/contracts/alerts';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';

export const dynamic = 'force-dynamic';

const CANONICAL_SCAN_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;
type CanonicalScanStatus = (typeof CANONICAL_SCAN_STATUSES)[number];

function normalizeScanStatus(status: string | null | undefined): CanonicalScanStatus | null {
  return CANONICAL_SCAN_STATUSES.includes(status as CanonicalScanStatus)
    ? (status as CanonicalScanStatus)
    : null;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiRequest(req, async () => {
    let ctx: Awaited<ReturnType<typeof requireAlertWorkspaceMember>>;
    try {
      ctx = await requireAlertWorkspaceMember(req);
    } catch (res) {
      return res as Response;
    }

    setRequestAuth({ userId: ctx.user.id, teamId: ctx.workspaceId });

    const { id } = await params;
    const { workspaceId, workspaceMemberId } = ctx;

    try {
      const row = await prisma.alert.findFirst({
        where: { id, teamId: workspaceId },
        include: {
          finding: {
            select: {
              cveId: true,
              lastRescoreAt: true,
              priorityScore: true,
              asset: { select: { id: true, host: true, ip: true, port: true, protocol: true } },
              scan: { select: { source: true } },
            },
          },
          // Per-alert cached AI "Explain with AI" prose — surfaced
          // alongside the existing cveSummary / cveFix back-refs so
          // the /alerts/[id] ExplainWithAiCard island can pre-render
          // the cached prose on first paint WITHOUT a second round
          // trip into /api/alerts/[id]/explain (the brief asks the
          // panel to "survive a full page reload"). The nested
          // `select` keeps the projection narrow — only the two
          // columns the AlertDetail envelope stamps onto the wire.
          // `explanation` is the per-alert 1:1 back-ref declared on
          // Alert; the inverse lives in
          // prisma/schema/cve-explanation.prisma alongside
          // AlertCveSummary / AlertCveFix so the Prisma @relation
          // is valid in both files. `null` on rows whose `explain`
          // POST hasn't yet streamed, AND on rows stamped before
          // the persistence tee landed.
          explanation: {
            select: { explanationText: true, generatedAt: true },
          },
        },
      });

      // Both a missing row and a row outside the active workspace resolve to
      // the same opaque answer. The workspace predicate is applied in SQL.
      if (!row) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      // `webhookConfigured` rides on the existing detail GET so the "Open
      // as Jira ticket" button on /alerts/[id] is driven by a single
      // authoritative read. Cheap primary-key lookup; the row's presence
      // is enough — never echo the URL on the wire.
      const webhook = await prisma.teamNotificationConfig.findUnique({
        where: { teamId: workspaceId },
        select: { id: true },
      });

      // CveEntry has no Prisma relation to VulnerabilityFinding (the join is
      // by the free-form `cveId` string column), so look it up explicitly.
      // Single second query per detail page; the cveId index keeps it cheap.
      const cveEntry = row.finding?.cveId
        ? await prisma.cveEntry.findUnique({
            where: { cveId: row.finding.cveId },
            select: { cvssScore: true, description: true },
          })
        : null;

      // Scan.source is a free-form string column, so the join can surface
      // values outside the canonical TriggeredBy union (legacy rows, hand-
      // stamped values). Validate per-row so the wire shape stays
      // consistent; the UI falls back to its 'manual' label on miss.
      const rawSource = row.finding?.scan?.source ?? null;
      const triggeredByResult =
        rawSource == null ? undefined : TriggeredByEnum.safeParse(rawSource);
      const triggeredBy = triggeredByResult?.success ? triggeredByResult.data : undefined;

      // The linked asset page normalizes hosts as DNS names (lowercase and
      // trimmed). Keep the scan lookup on that same host and active
      // workspace, then tolerate legacy scan statuses that are not part of
      // the detail contract.
      const normalizedAssetHost = row.finding?.asset?.host?.toLowerCase().trim() ?? '';
      const [latestScan, latestCompletedScan] = normalizedAssetHost
        ? await Promise.all([
            prisma.scan.findFirst({
              where: {
                teamId: workspaceId,
                assets: { some: { host: normalizedAssetHost } },
              },
              orderBy: { startedAt: 'desc' },
              select: { status: true, startedAt: true },
            }),
            prisma.scan.findFirst({
              where: {
                teamId: workspaceId,
                status: 'completed',
                assets: { some: { host: normalizedAssetHost } },
              },
              orderBy: { startedAt: 'desc' },
              select: { id: true },
            }),
          ])
        : [null, null];
      const latestScanStatus = normalizeScanStatus(latestScan?.status);
      const rawRiskScore = row.finding?.priorityScore;
      const riskScore =
        typeof rawRiskScore === 'number' && Number.isFinite(rawRiskScore) ? rawRiskScore : null;

      // Resolve owner display name. Resolve to null when the FK row is
      // missing or `User.name` is null — the picker renders the
      // "Unassigned" branch in that case so the user is never stranded.
      let ownerName: string | null = null;
      if (row.ownerId) {
        const member = await prisma.workspaceMember.findFirst({
          where: { id: row.ownerId, status: 'active' },
          select: { userId: true },
        });
        if (member?.userId) {
          const u = await prisma.user.findUnique({
            where: { id: member.userId },
            select: { name: true },
          });
          ownerName = u?.name ?? null;
        }
      }

      // Server-derived "most recent activity" stamp =
      // MAX(MAX(AlertNote.createdAt), remediatedAt, createdAt) per
      // alert — three-arm derivation so a brand-new row (no notes,
      // not yet remediated) still surfaces a wall-clock timestamp.
      // Read cheaply before the AlertDetail parse so the detail
      // envelope stamps `lastActivityAt` for the activity-card
      // subtitle without a second round trip. Team-scoped via
      // `alert: { teamId }` so a tampered id cannot surface
      // cross-team note-maxes. The `createdAt` fallback is
      // authoritative — Prisma always returns a Date for it —
      // so the stamp is effectively always defined on the wire.
      const lastActivity = await computeAlertLastActivityAtForOne(
        id,
        row.remediatedAt,
        row.createdAt,
        workspaceId,
      );

      // `me.isAssignee` — server-derived "is the caller this alert's
      // assignee". `Alert.ownerId` holds `WorkspaceMember.id` (the picker
      // writes that), NOT `Membership.id`; the active-workspace context
      // supplies the caller's active roster ID for this comparison.
      // Drives the assignee-only comment composer on /alerts/[id] — the
      // composer is mounted IFF this is true. Always computed server-side
      // so the UI never has to trust a client-side flip to gate the writer.
      const isAssignee = row.ownerId != null && row.ownerId === workspaceMemberId;

      const detail = AlertDetailSchema.parse({
        id: row.id,
        teamId: row.teamId,
        findingId: row.findingId,
        severity: row.severity ?? null,
        status: row.status,
        statusChangedAt: row.statusChangedAt ? row.statusChangedAt.toISOString() : null,
        source: row.source,
        ownerId: row.ownerId ?? null,
        ownerName,
        createdAt: row.createdAt.toISOString(),
        acknowledgedAt: row.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
        snoozedUntil: row.snoozedUntil ? row.snoozedUntil.toISOString() : null,
        cvssScore: cveEntry?.cvssScore ?? null,
        description: cveEntry?.description ?? '',
        cveId: row.finding?.cveId ?? '',
        asset: {
          id: row.finding?.asset?.id ?? '',
          host: row.finding?.asset?.host ?? '',
          ip: row.finding?.asset?.ip ?? '',
          port: row.finding?.asset?.port ?? 0,
          protocol: row.finding?.asset?.protocol ?? '',
          lastSeen: row.finding?.lastRescoreAt ? row.finding.lastRescoreAt.toISOString() : null,
          riskScore,
          latestScanStatus,
          latestScanAt: latestScan?.startedAt ? latestScan.startedAt.toISOString() : null,
          hasCompletedScan: latestCompletedScan !== null,
        },
        triggeredBy,
        webhookConfigured: webhook !== null,
        me: { isAssignee },
        // Operator-stamped FP reason — null on every non-FP row. The
        // detail page (mount via the existing GET) can render a
        // chip + reason subtitle without a second round trip; cleared
        // by /api/alerts/[id]/reopen. The row above uses `findFirst`
        // without `select`, so the new column rides the existing
        // response projection automatically — only the AlertDetail
        // parse call needs the widening here.
        falsePositiveReason: row.falsePositiveReason ?? null,
        // Close-stamp trio for `resolved` rows — read off the same
        // `findFirst` row above (Prisma returns every column by
        // default). All three fields are nullable on the detail
        // envelope: `closedAt` / `closedBy` are stamped once on the
        // FIRST transition to resolved (preserved across re-resolves);
        // `closingNote` is null when the operator didn't ship a note.
        // The trio is cleared by /api/alerts/[id]/reopen so a triage
        // flip back to `open` lands the row back to null in lockstep.
        // `closedBy` is stamped as the raw User.id — `closedByName`
        // resolution (via batched user.findMany) is the future
        // expansion; per the brief v1 stamps the id only.
        closedAt: row.closedAt ? row.closedAt.toISOString() : null,
        closedBy: row.closedBy ?? null,
        closingNote: row.closingNote ?? null,
        // Reopen-stamp trio. Mirrors the close trio posture: nullable
        // everywhere, stamped once on the FIRST transition from
        // `resolved` / `false_positive` back to `open`, preserved
        // across re-reopens. `reopenedAt` is the wall-clock stamp,
        // `reopenedBy` is the raw User.id (the future batched name
        // resolution lives on /api/alerts/[id]/activity; per the
        // brief v1 stamps the id only here). `reopenReason` is the
        // optional 0–500-char text the operator left on the reopen —
        // null when the body was blank/whitespace-only.
        reopenedAt: row.reopenedAt ? row.reopenedAt.toISOString() : null,
        reopenedBy: row.reopenedBy ?? null,
        reopenReason: row.reopenReason ?? null,
        // Operator-stamped "I acted on this" stamp. Null on every
        // unremediated row. The detail endpoint reads the column
        // off the same `findFirst` query above (Prisma returns
        // every column by default) and stamps it onto the
        // `AlertDetail` envelope so the detail page renders a
        // "Remediated at …" subtitle + the header button's
        // optimistic flip reconciles against the actual DB value
        // (the server is the authority for the timestamp). The
        // field rides the wire shape parity with AlertItem so the
        // list endpoint and the detail endpoint share one column
        // shape across both contracts. NOT cleared by /reopen
        // — flipping the row's triage status back to `open`
        // does NOT silently re-mark the alert as "still in
        // progress", since the stamp is the owner's manual flip
        // rather than a derived column.
        remediatedAt: row.remediatedAt ? row.remediatedAt.toISOString() : null,
        // Operator's email stamp captured at the same time
        // `remediatedAt` is set. Read off `Alert.remediatedByEmail`
        // off the same `findFirst` row above (Prisma returns every
        // column by default — no extra select widening required).
        // Null on every unremediated row, and ALSO null on rows
        // stamped by a caller whose WorkspaceMember.email AND
        // User.email were both missing at write-time. The detail
        // endpoint stamps it onto the AlertDetail envelope so the
        // detail header's "Remediated by <email>" subtitle renders
        // WITHOUT a second round trip; mirrors the AlertItem wire
        // shape exactly so list + detail share one column shape
        // end-to-end.
        remediatedByEmail: row.remediatedByEmail ?? null,
        // Server-derived "most recent activity" stamp =
        // MAX(remediatedAt, MAX(AlertNote.createdAt)) per alert.
        // Stamped onto the AlertDetail envelope above so the
        // activity sidebar can render a "Last activity: <relative>
        // (<absolute>)" subtitle line without a second round
        // trip. Newer AlertNote overrides remediatedAt when both
        // exist so an active shift handoff surfaces even on a
        // long-since-remediated row. Null when both inputs are
        // null (the row has never been remediated AND has no
        // handoff notes).
        lastActivityAt: lastActivity ? lastActivity.toISOString() : null,
        // Operator-stamped "Explain with AI" prose + timestamp —
        // read off the `explanation` back-ref on the same
        // `findFirst` query above. The nested `select` keeps
        // the projection narrow — only `explanationText` and
        // `generatedAt` ride the wire. `null` on rows whose
        // `explain` POST hasn't yet streamed (the cache miss
        // branch). The detail envelope carries these two
        // fields alongside the existing close / reopen /
        // remediated stamp trio so the ExplainWithAiCard island
        // can pre-render the cached prose on first paint
        // WITHOUT a second round trip into
        // /api/alerts/[id]/explain (the brief asks the panel to
        // "survive a full page reload"). Mirrors the AlertItem
        // shape exactly so list + detail share one column
        // shape end-to-end.
        lastExplainedAt: row.explanation?.generatedAt
          ? row.explanation.generatedAt.toISOString()
          : null,
        lastExplanationText: row.explanation?.explanationText ?? null,
      });

      return NextResponse.json(detail);
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
