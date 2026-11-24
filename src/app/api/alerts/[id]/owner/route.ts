// @polsia:user-owned — PATCH /api/alerts/[id]/owner. Claims (or releases)
// an alert for a workspace member. The accompanying GET on /api/alerts/[id]
// returns the same `ownerId/ownerName` pair so the detail envelope and the
// write response share a wire contract.
//
// The body's `ownerId` may be `null` (the picker renders an explicit
// "Unassigned" option) — that's an unconditional UPDATE, not a 400. A
// non-null `ownerId` MUST resolve to an active WorkspaceMember row in
// this team: cross-team ids are rejected with 400 + field error rather
// than the 404 opaque shape used elsewhere, because the input came from a
// picker the caller just rendered (you can't probe for row existence
// here — you can only mis-click).
//
// Resolution: re-read the alert + finding join and the WorkspaceMember
// (plus the User row for the display name) after the write so the
// returned AlertItem is fully consistent with the list endpoint's shape.
// If the owner FK is null by user action, ownerName resolves to null
// without an extra User lookup.

import 'server-only';
import { NextResponse } from 'next/server';
import { requireAlertWorkspaceMember } from '@/lib/business/alert-workspace-access';
import { AlertItem, AlertOwnerBody, TriggeredByEnum } from '@/lib/contracts/alerts';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';

export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
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

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { errors: { _: 'Request body must be valid JSON.' } },
        { status: 400 },
      );
    }

    const parsed = AlertOwnerBody.safeParse(raw);
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      const errors: Record<string, string> = {};
      for (const [field, messages] of Object.entries(fieldErrors)) {
        const first = messages?.[0];
        if (first) errors[field] = first;
      }
      if (Object.keys(errors).length === 0) errors._ = 'Invalid request body.';
      return NextResponse.json({ errors }, { status: 400 });
    }

    const { ownerId } = parsed.data;

    try {
      // Cross-team / not-found gate — opaque 404 same as the GET and the
      // triage route. A caller can't distinguish "no alert" from "wrong
      // team" from "right team, wrong id".
      const existing = await prisma.alert.findFirst({
        where: { id, teamId },
        select: { id: true },
      });
      if (!existing) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      // The cross-team guard for a non-null ownerId. We do NOT use
      // `requireTeamRole('admin')` here — but we do require the row to be
      // a real, active member of this workspace. A foreign-workspace
      // WorkspaceMember.id returns a 400 because the caller just rendered
      // this id from a picker tied to the current workspace — there's no
      // probing path (so we don't need the opaque 404 posture here).
      if (ownerId !== null) {
        const member = await prisma.workspaceMember.findFirst({
          where: { id: ownerId, workspaceId: teamId, status: 'active' },
          select: { id: true },
        });
        if (!member) {
          return NextResponse.json(
            {
              errors: {
                ownerId: 'The selected option is not an active member of this workspace.',
              },
            },
            { status: 400 },
          );
        }
      }

      await prisma.alert.update({
        where: { id },
        data: { ownerId },
      });

      // Re-read with the same shape as the list endpoint so the response
      // parses against AlertItem (one contract, two routes).
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

      // Resolve ownerName from the FK. Null FK -> null display name; FK
      // present but no User-name or User row -> null display name (the
      // picker renders "Unassigned" on null name just as on null id).
      let ownerName: string | null = null;
      if (ownerId !== null) {
        const member = await prisma.workspaceMember.findFirst({
          where: { id: ownerId, status: 'active' },
          select: { id: true, userId: true, email: true },
        });
        if (member?.userId) {
          const u = await prisma.user.findUnique({
            where: { id: member.userId },
            select: { name: true },
          });
          ownerName = u?.name ?? null;
        }
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
    { status: 405, headers: { Allow: 'PATCH' } },
  );
}

export const GET = methodNotAllowed;
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const DELETE = methodNotAllowed;
