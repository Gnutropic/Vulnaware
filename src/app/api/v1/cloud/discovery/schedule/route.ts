// @polsia:user-owned — Admin-gated REST for per-team scheduled cloud
// discovery runs. POST /api/v1/cloud/discovery/schedule creates a row tied
// to the caller's team (resolved from their Membership, NEVER trusted from
// the body). DELETE for a single row lives at [id]/route.ts.
//
// Auth: same posture as /api/v1/keys — `requireAuth` + an inline
// `requireAdminJson` helper that returns 403 JSON instead of redirecting,
// because the `requireAdmin` server guard redirects to /login (wrong for
// an API route). We deliberately do NOT use `requireTeamRole('admin')`
// because the brief asks for a 404-on-no-membership posture, and that
// helper would 404 before we get a chance to write the audit row.
//
// Cross-team isolation: POST reads teamId strictly from membership; DELETE
// filters the where clause to { id, teamId } so a foreign-team id surfaces
// as 404 (never reveal existence).

import 'server-only';
import { NextResponse } from 'next/server';
import { audit, extractIp } from '@/lib/business/audit';
import {
  CloudDiscoveryScheduleCreate,
  CloudDiscoveryScheduleItem,
  CloudDiscoveryScheduleList,
  MIN_CADENCE_MINUTES,
} from '@/lib/contracts/cloud-discovery';
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

export async function POST(req: Request) {
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

      let json: unknown;
      try {
        json = await req.json();
      } catch {
        return NextResponse.json({ code: 'bad_request', message: 'invalid JSON' }, { status: 400 });
      }
      const parsed = CloudDiscoveryScheduleCreate.safeParse(json);
      if (!parsed.success) {
        const errors: Record<string, string> = {};
        for (const [field, messages] of Object.entries(parsed.error.flatten().fieldErrors)) {
          const first = messages?.[0];
          if (first) errors[field] = first;
        }
        return NextResponse.json({ errors }, { status: 400 });
      }

      // Defense-in-depth: re-check the cadence floor even though zod
      // narrowed the input. The contract is the source of truth.
      if (parsed.data.cadenceMinutes < MIN_CADENCE_MINUTES) {
        return NextResponse.json(
          { errors: { cadenceMinutes: `Minimum cadence is ${MIN_CADENCE_MINUTES} minutes` } },
          { status: 400 },
        );
      }

      try {
        const created = await prisma.cloudDiscoverySchedule.create({
          data: {
            teamId,
            provider: parsed.data.provider,
            cadenceMinutes: parsed.data.cadenceMinutes,
            nextRunAt: new Date(),
            createdById: authResult.id,
          },
        });

        const out = CloudDiscoveryScheduleItem.parse({
          id: created.id,
          teamId: created.teamId,
          provider: created.provider,
          cadenceMinutes: created.cadenceMinutes,
          lastRunAt: created.lastRunAt ? created.lastRunAt.toISOString() : null,
          nextRunAt: created.nextRunAt.toISOString(),
          createdById: created.createdById,
          createdAt: created.createdAt.toISOString(),
        });

        void audit({
          actorUserId: authResult.id,
          actorTeamId: teamId,
          action: 'cloud_discovery_schedule.create',
          resourceType: 'cloud_discovery_schedule',
          resourceId: created.id,
          metadata: {
            provider: created.provider,
            cadenceMinutes: created.cadenceMinutes,
          },
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

export function GET(req: Request) {
  return withRateLimit(req, () =>
    withApiRequest(req, async () => {
      const authResult = await requireAdminJson(req);
      if (authResult instanceof Response) return authResult;

      const membership = await prisma.membership.findUnique({
        where: { userId: authResult.id },
        select: { teamId: true },
      });
      if (!membership) {
        return NextResponse.json({ error: 'No team' }, { status: 404 });
      }

      const rows = await prisma.cloudDiscoverySchedule.findMany({
        where: { teamId: membership.teamId },
        orderBy: { createdAt: 'asc' },
      });

      const items = rows.map((row) =>
        CloudDiscoveryScheduleItem.parse({
          id: row.id,
          teamId: row.teamId,
          provider: row.provider,
          cadenceMinutes: row.cadenceMinutes,
          lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
          nextRunAt: row.nextRunAt.toISOString(),
          createdById: row.createdById,
          createdAt: row.createdAt.toISOString(),
        }),
      );

      return NextResponse.json(CloudDiscoveryScheduleList.parse({ items }), { status: 200 });
    }),
  );
}

export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
