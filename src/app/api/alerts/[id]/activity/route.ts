// @polsia:user-owned — GET /api/alerts/[id]/activity. Per-alert
// lifecycle event feed — currently scope-resolved to one event per
// row that's ever been reopened. Future expansion (resolve events,
// FP events, owner-change events) widens the `AlertActivityItem`
// literal-union `id` and re-introduces a real cursor; v1 ships
// the reopen-only shape because a row can carry at most one
// reopen event in steady state.
//
// Access-control posture mirrors /resolve 1:1:
//   - 401 anon / 403 below-member — opaque.
//   - Cross-team id (or fully missing row) → opaque 404 BEFORE any
//     user read.
//   - findFirst above scopes by `where: { id, teamId }` — the
//     activity feed rides the existing detail-envelope scope
//     check so a tampered URL never surfaces another team's
//     activity row.
//
// v1 timeline shape:
//   - Reads `reopenedAt` / `reopenedBy` / `reopenReason` directly
//     off the `Alert` row + a single batched `User.findMany`
//     peer-read for `actorName`. No separate `AlertActivity`
//     table — the trio rule for v1 is the additive-only path; a
//     separate Timeline model is a future mid-cycle refactor.
//
// Fail-closed:
//   - Any throw inside the route → 500 JSON.

import 'server-only';
import { NextResponse } from 'next/server';
import { requireAlertWorkspaceMember } from '@/lib/business/alert-workspace-access';
import { AlertActivityItem, AlertActivityList } from '@/lib/contracts/alerts';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';

export const dynamic = 'force-dynamic';

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
    const teamId = ctx.workspaceId;

    try {
      const row = await prisma.alert.findFirst({
        where: { id, teamId },
        select: {
          id: true,
          reopenedAt: true,
          reopenedBy: true,
          reopenReason: true,
        },
      });
      if (!row) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      // No reopen event yet → empty list. Stamping the trio fields
      // on a non-reopened row would surface a phantom event.
      if (!row.reopenedAt || !row.reopenedBy) {
        return NextResponse.json(AlertActivityList.parse({ items: [], nextCursor: null }));
      }

      // Batched `User.findMany` peer-read for `actorName` — mirror
      // of the `ownerName` flow on /api/alerts/[id] and the
      // `authorName` flow on /api/alerts/[id]/comments. Names are
      // best-effort (`null` when the User row is gone — soft-delete
      // edge case; the timeline card de-renders to "Unknown
      // actor"). A single batched read keeps the round-trip cost
      // independent of the lifetime event count, which matters
      // when the timeline widens to multiple events per row.
      const users = await prisma.user.findMany({
        where: { id: { in: [row.reopenedBy] } },
        select: { id: true, name: true },
      });
      const nameById = new Map(users.map((u) => [u.id, u.name ?? null] as const));

      const item = AlertActivityItem.parse({
        id: 'reopen',
        at: row.reopenedAt.toISOString(),
        actorId: row.reopenedBy,
        actorName: nameById.get(row.reopenedBy) ?? null,
        reason: row.reopenReason ?? null,
      });

      const list = AlertActivityList.parse({ items: [item], nextCursor: null });
      return NextResponse.json(list);
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
