// @polsia:user-owned — DELETE /api/v1/cloud/discovery/schedule/[id].
// Admin-only. Cross-team rows surface as 404 (never reveal existence) —
// the same posture as soft-revoke-API-key (src/app/api/v1/keys/[id]/route.ts).
//
// Implementation note: we use a single `prisma.cloudDiscoverySchedule.delete`
// with `where: { id, teamId }`. The DELETE returns rowCount=0 when neither
// a same-team row exists nor a cross-team row matches — both cases map to
// 404. This avoids an extra find-then-delete round-trip and intentionally
// folds "not found" and "foreign-team" into the same observable response.

import 'server-only';
import { NextResponse } from 'next/server';
import { audit, extractIp } from '@/lib/business/audit';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { withRateLimit } from '@/lib/rate-limit';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

async function requireAdminJson(req: Request): Promise<SessionUser | Response> {
  let user: SessionUser;
  try {
    user = await requireAuth(req);
  } catch (res) {
    return res as Response;
  }
  if (user.role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return user;
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRateLimit(req, () =>
    withApiRequest(req, async () => {
      const authResult = await requireAdminJson(req);
      if (authResult instanceof Response) return authResult;

      setRequestAuth({ userId: authResult.id, teamId: 'unresolved' });

      const membership = await prisma.membership.findUnique({
        where: { userId: authResult.id },
        select: { id: true, teamId: true },
      });
      if (!membership) {
        return NextResponse.json({ error: 'No team' }, { status: 404 });
      }
      const teamId = membership.teamId;
      setRequestAuth({ teamId });

      const { id } = await params;

      try {
        const { count } = await prisma.cloudDiscoverySchedule.deleteMany({
          where: { id, teamId },
        });
        if (count === 0) {
          return NextResponse.json({ error: 'not_found' }, { status: 404 });
        }
        void audit({
          actorUserId: authResult.id,
          actorTeamId: teamId,
          action: 'cloud_discovery_schedule.delete',
          resourceType: 'cloud_discovery_schedule',
          resourceId: id,
          metadata: {},
          ipAddress: extractIp(req),
        });
        return new NextResponse(null, { status: 204 });
      } catch {
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
      }
    }),
  );
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'DELETE' } },
  );
}

export const GET = methodNotAllowed;
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
