// @polsia:user-owned — Manager CRUD for webhooks.
// GET  /api/v1/webhooks       — list webhooks for the caller's team
// POST /api/v1/webhooks       — create a webhook (returns the ONE-TIME plaintext)
// DELETE handled separately in /api/v1/webhooks/[id]/route.ts.
//
// Admin gating: admin session cookie (better-auth). Mirrors keys/route.ts
// for auth + team resolution + audit posture.

import 'server-only';
import { NextResponse } from 'next/server';
import { audit, extractIp } from '@/lib/business/audit';
import { createWebhook, listWebhooks } from '@/lib/business/webhooks';
import { WebhookCreateBody, WebhookCreateResponse, WebhookList } from '@/lib/contracts/webhooks';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { withRateLimit } from '@/lib/rate-limit';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

function getUserTeamName(user: SessionUser): string {
  if (user.role !== 'admin') return 'users';
  return 'system';
}

async function getOrCreateTeamForUser(user: SessionUser): Promise<string> {
  const name = getUserTeamName(user);
  const team = await prisma.team.upsert({
    where: { name },
    update: {},
    create: { name },
  });
  return team.id;
}

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
  return withRateLimit(req, () =>
    withApiRequest(req, async () => {
      const authResult = await requireAdminJson(req);
      if (authResult instanceof NextResponse) return authResult;

      setRequestAuth({ userId: authResult.id, teamId: 'unresolved' });

      const teamId = await getOrCreateTeamForUser(authResult);
      setRequestAuth({ teamId });

      try {
        const rows = await listWebhooks(teamId);
        const items = WebhookList.parse({
          items: rows.map((r) => ({
            id: r.id,
            url: r.url,
            signingAlgorithm: r.signingAlgorithm as 'hmac-sha256',
            lastSignedAt: r.lastSignedAt ? r.lastSignedAt.toISOString() : null,
            createdAt: r.createdAt.toISOString(),
            revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
            team: { id: r.team.id, name: r.team.name },
          })),
        });
        return NextResponse.json(items);
      } catch {
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
      }
    }),
  );
}

export async function POST(req: Request) {
  return withRateLimit(req, () =>
    withApiRequest(req, async () => {
      const authResult = await requireAdminJson(req);
      if (authResult instanceof NextResponse) return authResult;

      setRequestAuth({ userId: authResult.id, teamId: 'unresolved' });

      const teamId = await getOrCreateTeamForUser(authResult);
      setRequestAuth({ teamId });

      let json: unknown;
      try {
        json = await req.json();
      } catch {
        return NextResponse.json({ code: 'bad_request', message: 'invalid JSON' }, { status: 400 });
      }
      const parsed = WebhookCreateBody.safeParse(json);
      if (!parsed.success) {
        const errors: Record<string, string> = {};
        for (const [field, messages] of Object.entries(parsed.error.flatten().fieldErrors)) {
          const first = messages?.[0];
          if (first) errors[field] = first;
        }
        return NextResponse.json({ errors }, { status: 400 });
      }

      try {
        const created = await createWebhook({ url: parsed.data.url, teamId });
        const out = WebhookCreateResponse.parse({
          id: created.record.id,
          url: created.record.url,
          signingAlgorithm: created.record.signingAlgorithm as 'hmac-sha256',
          lastSignedAt: created.record.lastSignedAt
            ? created.record.lastSignedAt.toISOString()
            : null,
          createdAt: created.record.createdAt.toISOString(),
          revokedAt: created.record.revokedAt ? created.record.revokedAt.toISOString() : null,
          team: { id: created.record.teamId, name: '' }, // filled from DB below
          secret: created.plaintext,
        });
        // Fetch full team summary for the response.
        const team = await prisma.team.findUniqueOrThrow({
          where: { id: teamId },
          select: { id: true, name: true },
        });
        out.team = { id: team.id, name: team.name };

        void audit({
          actorUserId: authResult.id,
          actorTeamId: teamId,
          action: 'webhook.create',
          resourceType: 'webhook',
          resourceId: created.record.id,
          metadata: { url: created.record.url },
          ipAddress: extractIp(req),
        });

        return NextResponse.json(out, { status: 201 });
      } catch {
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
      }
    }),
  );
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
