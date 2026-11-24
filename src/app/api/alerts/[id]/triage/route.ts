// @polsia:user-owned — POST /api/alerts/[id]/triage. Stamps
// `acknowledgedAt` on the team-scoped alert row (idempotent soft-update —
// re-triage overwrites with the latest timestamp so a UI that lost state
// never gets stuck on a stale "triaged" button).
//
// Access-control posture mirrors the GET and the list route: gated by
// requireTeamRole('member'), the `findFirst` lookup is seeded with
// `teamId` so a cross-team id (or missing row) resolves to the same opaque
// 404 as the GET — no existence leak.
// Lives at /api/alerts/[id]/triage (not under /api/alerts/[id]`) so the
// GET handler stays read-only and the 405 stub posture carries through.

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
      // Verify the row exists for THIS team before writing — fail with the
      // same opaque 404 as a missing row so cross-team probing can't
      // distinguish from a legitimate not-found.
      const existing = await prisma.alert.findFirst({
        where: { id, teamId },
        select: { id: true },
      });
      if (!existing) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      // Soft-update: latest stamp wins. No 409 on re-triage — the detail
      // page's button disables once `acknowledgedAt != null` so the common
      // case is a single stamp, but idempotency beats a swallowed write.
      await prisma.alert.update({
        where: { id },
        data: { acknowledgedAt: new Date() },
      });

      // Re-read with the same shape as the list endpoint so the client
      // parses the response against AlertItem (one contract, two routes).
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

      // Scan.source is a free-form string column — same per-row
      // TriggeredByEnum gate as the list/GET handlers so union drift can't
      // surface an unparsed enum value to the wire.
      const rawSource = row.finding?.scan?.source ?? null;
      const triggeredByResult =
        rawSource == null ? undefined : TriggeredByEnum.safeParse(rawSource);
      const triggeredBy = triggeredByResult?.success ? triggeredByResult.data : undefined;

      // Resolve ownerName for the AlertItem response. Single row here so no
      // batched join — see /api/alerts/[id]/owner for the same pattern.
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
