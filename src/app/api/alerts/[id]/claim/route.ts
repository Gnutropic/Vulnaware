// @polsia:user-owned — POST /api/alerts/[id]/claim. Assigns the caller as
// this alert's owner (sets `Alert.ownerId` to the caller's
// `WorkspaceMember.id` for the current team). Mirrors the structure of
// `PATCH /api/alerts/[id]/owner` but skips the body-FK validation: the
// assignee is the caller, the route gets the id from the session, no
// body — so there's no attacker-controlled id to validate against.
//
// Snooze-arm gate (per the brief): a row whose `snoozedUntil` falls in
// the future is Silently skipped — the route returns the on-disk
// `AlertItem` envelope WITHOUT stamping `ownerId`. The page discovers
// the snooze via the next refetch (the row's `snoozedUntil` is still
// set; the unsnoozed pill stays visible) and the operator can choose to
// un-snooze first, then re-claim. This matches the brief's wording
// ("claim paths should ignore them") and keeps re-triagability intact
// — a snoozed row stays unclaimed/untouched.
//
// Access-control posture mirrors every other per-alert subroute:
// `requireTeamRole('member')`, the `findFirst` lookup is seeded with
// `teamId` so cross-team probing can't distinguish from a legitimate
// not-found. The route returns the same `AlertItem` envelope as the
// PATCH /owner handler so the client's optimistic flip + parent
// refetch parse against the existing wire shape.
//
// Idempotent on the non-snoozed branch — re-claim overwrites the FK
// with the caller's id, so a stale click race (the picker flipped to
// someone else in between) lands on the caller's id, not a 409.

import 'server-only';
import { NextResponse } from 'next/server';
import { requireAlertWorkspaceMember } from '@/lib/business/alert-workspace-access';
import { AlertItem, TriggeredByEnum } from '@/lib/contracts/alerts';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiRequest(req, async () => {
    let ctx: Awaited<ReturnType<typeof requireAlertWorkspaceMember>>;
    try {
      ctx = await requireAlertWorkspaceMember(req);
    } catch (res) {
      return res as Response;
    }

    setRequestAuth({ userId: ctx.user.id, teamId: ctx.workspaceId });

    const { id } = await params;
    const teamId = ctx.workspaceId;

    try {
      // Resolve caller's WorkspaceMember.id for the current team. Same
      // shape the detail GET uses for `me.isAssignee`. Defensive 404 if
      // missing — shouldn't happen given `requireTeamRole` succeeded,
      // but a team bootstrap inconsistency is better surfaced than a
      // 500.
      const callerWorkspaceMember = await prisma.workspaceMember.findFirst({
        where: { userId: ctx.user.id, workspaceId: teamId, status: 'active' },
        select: { id: true },
      });
      if (!callerWorkspaceMember) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      // Opaque cross-team 404 — same posture as the GET and the owner
      // PATCH. A caller can't distinguish "no alert" from "wrong team"
      // from "right team, wrong id". The select pulls `snoozedUntil`
      // alongside `id` so the snooze-arm gate below needs no second
      // read.
      const existing = await prisma.alert.findFirst({
        where: { id, teamId },
        select: { id: true, snoozedUntil: true },
      });
      if (!existing) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      // Snooze-arm gate. A row whose future snooze window is still
      // active must NOT take a new owner — return the on-disk
      // AlertItem without firing the `ownerId` UPDATE so the page's
      // refetch reconciles with the unchanged column state.
      // Elapsed snoozes (snoozedUntil <= now) and null snoozes fall
      // through to the normal claim path.
      const activeNow = new Date();
      const futureSnooze = existing.snoozedUntil !== null && existing.snoozedUntil > activeNow;

      if (!futureSnooze) {
        await prisma.alert.update({
          where: { id },
          data: { ownerId: callerWorkspaceMember.id },
        });
      }

      // Re-read with the same shape as the list endpoint so the response
      // parses against `AlertItem` (one contract, two routes). Same
      // projection the PATCH /owner handler uses.
      const row = await prisma.alert.findUnique({
        where: { id },
        include: {
          finding: {
            select: {
              cveId: true,
              asset: { select: { host: true, port: true, protocol: true } },
              scan: { select: { source: true } },
            },
          },
        },
      });
      if (!row || row.teamId !== teamId) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      // Resolve ownerName from the FK. We just stamped it to the
      // caller's WorkspaceMember row, so the lookup is guaranteed to
      // resolve to a User (as long as the row exists) — but a missing
      // `User.name` still falls through to null so the wire shape stays
      // consistent with the picker / list endpoint.
      const member = await prisma.workspaceMember.findFirst({
        where: { id: row.ownerId ?? '', status: 'active' },
        select: { id: true, userId: true },
      });
      let ownerName: string | null = null;
      if (member?.userId) {
        const u = await prisma.user.findUnique({
          where: { id: member.userId },
          select: { name: true },
        });
        ownerName = u?.name ?? null;
      }

      const rawSource = row.finding?.scan?.source ?? null;
      const triggeredByResult =
        rawSource == null ? undefined : TriggeredByEnum.safeParse(rawSource);
      const triggeredBy = triggeredByResult?.success ? triggeredByResult.data : undefined;

      const item = AlertItem.parse({
        id: row.id,
        teamId: row.teamId,
        findingId: row.findingId,
        severity: row.severity ?? null,
        status: row.status,
        source: row.source,
        assigneeId: row.assigneeId ?? null,
        ownerId: row.ownerId ?? null,
        ownerName,
        createdAt: row.createdAt.toISOString(),
        acknowledgedAt: row.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
        snoozedUntil: row.snoozedUntil ? row.snoozedUntil.toISOString() : null,
        cveId: row.finding?.cveId ?? '',
        asset: {
          host: row.finding?.asset?.host ?? '',
          port: row.finding?.asset?.port ?? 0,
          protocol: row.finding?.asset?.protocol ?? '',
        },
        triggeredBy,
      });

      return NextResponse.json(item);
    } catch {
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  });
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'POST' } },
  );
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
