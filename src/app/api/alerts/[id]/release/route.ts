// @polsia:user-owned — POST /api/alerts/[id]/release. Clears the alert's
// `ownerId` back to `null` IFF the caller is the current owner. Mirror of
// POST /claim: same auth posture, same opaque cross-team 404, same
// `AlertItem` response envelope. Only mutation precondition is the
// caller-is-owner check — a stale click race after someone else took
// ownership lands on `{ error: 'not_owner' }` 409 instead of silently
// clearing someone else's claim.
//
// Symmetric with /claim so the post-release flow lands on
// `PATCH /owner` semantics (null FK) — the picker's
// "Unassigned" branch and this release button share the same wire
// outcome.

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
      // missing — shouldn't happen given `requireTeamRole` succeeded.
      const callerWorkspaceMember = await prisma.workspaceMember.findFirst({
        where: { userId: ctx.user.id, workspaceId: teamId, status: 'active' },
        select: { id: true },
      });
      if (!callerWorkspaceMember) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      // Opaque cross-team 404 — same posture as /claim, GET, and the
      // owner PATCH. A caller can't distinguish "no alert" from "wrong
      // team" from "right team, wrong id".
      const existing = await prisma.alert.findFirst({
        where: { id, teamId },
        select: { id: true, ownerId: true },
      });
      if (!existing) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      // Caller-is-owner precondition. 409 because the row is in a
      // state the caller can't transition out of — a stale click race
      // after the picker flipped ownership to someone else. The
      // button on the page is gated by `detail.me.isAssignee`, so this
      // branch only lands when the optimistic flip + server stamp
      // disagree (e.g. two browser tabs).
      if (existing.ownerId !== callerWorkspaceMember.id) {
        return NextResponse.json({ error: 'not_owner' }, { status: 409 });
      }

      await prisma.alert.update({
        where: { id },
        data: { ownerId: null },
      });

      // Re-read with the same shape as the list endpoint so the response
      // parses against `AlertItem` (one contract, two routes).
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

      const rawSource = row.finding?.scan?.source ?? null;
      const triggeredByResult =
        rawSource == null ? undefined : TriggeredByEnum.safeParse(rawSource);
      const triggeredBy = triggeredByResult?.success ? triggeredByResult.data : undefined;

      // ownerId is null after release, so ownerName resolves to null
      // without a WorkspaceMember / User lookup (mirrors the picker
      // "Unassigned" branch).
      const item = AlertItem.parse({
        id: row.id,
        teamId: row.teamId,
        findingId: row.findingId,
        severity: row.severity ?? null,
        status: row.status,
        source: row.source,
        assigneeId: row.assigneeId ?? null,
        ownerId: row.ownerId ?? null,
        ownerName: null,
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
