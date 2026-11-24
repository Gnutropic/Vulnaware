// @polsia:user-owned — soft-revoke a webhook. Admin-only. Foreign-team
// -> 404 (never reveal existence cross-team); already revoked -> 409.

import 'server-only';
import { NextResponse } from 'next/server';
import { audit, extractIp } from '@/lib/business/audit';
import { getWebhookById, revokeWebhook } from '@/lib/business/webhooks';
import { IdParam } from '@/lib/contracts/webhooks';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { withRateLimit } from '@/lib/rate-limit';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

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

async function resolveCallerTeamId(user: SessionUser): Promise<string> {
  const name = user.role === 'admin' ? 'system' : 'users';
  const team = await prisma.team.upsert({
    where: { name },
    update: {},
    create: { name },
  });
  return team.id;
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRateLimit(req, () =>
    withApiRequest(req, async () => {
      const authResult = await requireAdminJson(req);
      if (authResult instanceof NextResponse) return authResult;

      setRequestAuth({ userId: authResult.id, teamId: 'unresolved' });

      const { id } = await params;
      const idCheck = IdParam.safeParse(id);
      if (!idCheck.success) {
        return NextResponse.json(
          { error: 'bad_request', reason: 'invalid id format' },
          { status: 400 },
        );
      }

      const teamId = await resolveCallerTeamId(authResult);
      setRequestAuth({ teamId });

      try {
        const existing = await getWebhookById(idCheck.data, teamId);
        if (!existing) {
          // Foreign-team OR not-found — same posture (404). Prevents existence
          // probing across teams.
          return NextResponse.json({ error: 'not_found' }, { status: 404 });
        }
        if (existing.revokedAt) {
          return NextResponse.json({ error: 'already_revoked' }, { status: 409 });
        }
        await revokeWebhook(idCheck.data, teamId);
        void audit({
          actorUserId: authResult.id,
          actorTeamId: teamId,
          action: 'webhook.revoke',
          resourceType: 'webhook',
          resourceId: idCheck.data,
          metadata: { url: existing.url },
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
