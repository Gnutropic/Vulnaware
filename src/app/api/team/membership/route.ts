// @polsia:user-owned — GET /api/team/membership. Returns the
// caller's own WorkspaceMember row + resolved display name for the
// current team. Used by the /alerts page's bulk "Take ownership"
// gesture to seed `callerWorkspaceMemberIdRef` and `callerNameRef`
// off a single round-trip per session.
//
// Companion to GET /api/team/members (the full workspace roster
// used by the alert-detail owner picker). The picker row is broader
// — it lists every active member of the team so the picker has an
// option per colleague. /api/team/membership returns ONLY the
// caller's row, so a page-side imperative handle can seed from a
// single, narrow lookup without dragging the full roster into state.
//
// Resolution: `WorkspaceMember.findFirst({ where: { userId:
// ctx.user.id, workspaceId, status: 'active' } })` plus a peer-read
// `prisma.user.findUnique({ select: { name: true } })` for the
// display name. Both rows are already peer-read at the top of
// `POST /api/alerts/ownership-batch` so this endpoint mirrors the
// same shape end-to-end (the page-side helper uses `callerName`
// directly off this response).
//
// Behaviour:
//   - Anonymous → 401 from `requireTeamRole('member')`.
//   - Below-member → 403.
//
// Wire shape:
//   - `id`        — WorkspaceMember.id (the FK stamped onto
//                   `Alert.ownerId` by /api/alerts/ownership-batch
//                   and /api/alerts/[id]/claim).
//   - `userId`    — the locked `User.id` FK.
//   - `email`     — WorkspaceMember.email (best-effort; matches
//                   the session-email on bootstrap rows).
//   - `name`      — User.name resolved once peer-side; null on a
//                   missing User row OR a missing User.name column.
//
// Fail-closed: any throw → 500 JSON.

import 'server-only';
import { NextResponse } from 'next/server';
import { TeamMembership } from '@/lib/contracts/team';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { requireTeamRole } from '@/lib/team-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return withApiRequest(req, async () => {
    let ctx: Awaited<ReturnType<typeof requireTeamRole>>;
    try {
      ctx = await requireTeamRole('member');
    } catch (res) {
      return res as Response;
    }

    setRequestAuth({ userId: ctx.user.id, teamId: ctx.membership.teamId });
    const teamId = ctx.membership.teamId;

    try {
      // Same shape `POST /api/alerts/ownership-batch` and
      // `POST /api/alerts/[id]/claim` peer-read — narrow
      // `{id, userId, email}` projection so a follow-up flip on
      // the page-side helper can stamp `ownerId` directly.
      const row = await prisma.workspaceMember.findFirst({
        where: { userId: ctx.user.id, workspaceId: teamId, status: 'active' },
        select: { id: true, userId: true, email: true },
      });
      if (!row) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }
      // Peer-read User.name so the page-side helper's
      // `callerNameRef` can seed without a second round trip on
      // the optimistic flip. The result envelope tolerates a null
      // name (the picker / list endpoint collapse "null name" to
      // a placeholder label without an extra round trip).
      const user = row.userId
        ? await prisma.user.findUnique({
            where: { id: row.userId },
            select: { name: true },
          })
        : null;
      const name = user?.name ?? null;

      const parsed = TeamMembership.parse({
        id: row.id,
        userId: row.userId ?? '',
        email: row.email ?? null,
        name,
      });
      return NextResponse.json(parsed);
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
