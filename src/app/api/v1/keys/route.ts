// @polsia:user-owned — Manager CRUD for API keys.
// GET  /api/v1/keys       — list keys for the caller's team
// POST /api/v1/keys       — create a key (returns the ONE-TIME plaintext)
// DELETE handled separately in /api/v1/keys/[id]/route.ts.
//
// Admin gating: this endpoint is admin-only (better-auth session + role
// 'admin'). Far simpler than scoping to per-user keys because the surface
// IS the keys-management page — we don't have per-user API consumers. The
// session user is mapped to their team via `getUserTeamName` so the
// bootstrap system team can coexist with future per-user teams.

import 'server-only';
import { NextResponse } from 'next/server';
import { createApiKey } from '@/lib/business/api-keys';
import { audit, extractIp } from '@/lib/business/audit';
import { ApiKeyCreateBody, ApiKeyCreateResponse, ApiKeyList } from '@/lib/contracts/api-key';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { withRateLimit } from '@/lib/rate-limit';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

// Resolve the team a session user is operating as. The simple model here:
// every admin is on the 'system' team (the only team the bootstrap seeds).
// If a future feature introduces per-org teams, switch this to look up
// `teamMembers` (out of scope for this change).
function getUserTeamName(user: SessionUser): string {
  if (user.role !== 'admin') {
    return 'users';
  }
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

// Admin gate helper. requireAdmin (from @/lib/require-admin) redirects to
// /login on a missing session — that's correct for pages, wrong for an API
// route. Use requireAuth + a JSON 403 instead so fetch callers get a sane
// response.
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
        const rows = await prisma.apiKey.findMany({
          where: { teamId },
          orderBy: { createdAt: 'desc' },
          include: { team: { select: { id: true, name: true } } },
        });
        const items = ApiKeyList.parse({
          items: rows.map((r) => ({
            id: r.id,
            name: r.name,
            scopeKind: r.scopeKind === 'scan' ? 'scan' : 'team',
            scanId: r.scanId ?? null,
            team: { id: r.team.id, name: r.team.name },
            createdAt: r.createdAt.toISOString(),
            lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
            revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
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
      const parsed = ApiKeyCreateBody.safeParse(json);
      if (!parsed.success) {
        const errors: Record<string, string> = {};
        for (const [field, messages] of Object.entries(parsed.error.flatten().fieldErrors)) {
          const first = messages?.[0];
          if (first) errors[field] = first;
        }
        return NextResponse.json({ errors }, { status: 400 });
      }

      try {
        const created = await createApiKey({
          name: parsed.data.name,
          teamId,
          scopeKind: parsed.data.scopeKind,
          scanId: parsed.data.scanId ?? null,
        });
        const team = await prisma.team.findUniqueOrThrow({
          where: { id: teamId },
          select: { id: true, name: true },
        });
        const out = ApiKeyCreateResponse.parse({
          id: created.record.id,
          name: created.record.name,
          scopeKind: created.record.scopeKind,
          scanId: created.record.scanId ?? null,
          team: { id: team.id, name: team.name },
          createdAt: created.record.createdAt.toISOString(),
          lastUsedAt: created.record.lastUsedAt ? created.record.lastUsedAt.toISOString() : null,
          revokedAt: created.record.revokedAt ? created.record.revokedAt.toISOString() : null,
          secret: created.plaintext,
        });
        void audit({
          actorUserId: authResult.id,
          actorTeamId: teamId,
          action: 'api_key.create',
          resourceType: 'api_key',
          resourceId: created.record.id,
          metadata: { name: created.record.name, scopeKind: created.record.scopeKind },
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
