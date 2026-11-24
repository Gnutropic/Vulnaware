// @polsia:user-owned — Paginated audit event list for admin users.
// GET /api/v1/audit-events — team-scoped, admin-only.

import 'server-only';
import { NextResponse } from 'next/server';
import { AuditEventItem, AuditEventList, AuditEventQuery } from '@/lib/contracts/audit-event';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { withRateLimit } from '@/lib/rate-limit';
import { requireTeamRole } from '@/lib/team-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return withRateLimit(req, () =>
    withApiRequest(req, async () => {
      let ctx: Awaited<ReturnType<typeof requireTeamRole>>;
      try {
        ctx = await requireTeamRole('admin');
      } catch (res) {
        return res as Response;
      }

      setRequestAuth({ userId: ctx.user.id, teamId: ctx.membership.teamId });

      const url = new URL(req.url);
      const rawQuery = Object.fromEntries(url.searchParams.entries());
      const parsed = AuditEventQuery.safeParse(rawQuery);
      if (!parsed.success) {
        return NextResponse.json(
          { error: 'bad_request', issues: parsed.error.flatten() },
          { status: 400 },
        );
      }

      const { actor, action, resourceType, from, to, page, pageSize } = parsed.data;
      const teamId = ctx.membership.teamId;

      const where = {
        actorTeamId: teamId,
        ...(actor ? { actorUserId: actor } : {}),
        ...(action ? { action } : {}),
        ...(resourceType ? { resourceType } : {}),
        ...(from || to
          ? {
              createdAt: {
                ...(from ? { gte: new Date(from) } : {}),
                ...(to ? { lte: new Date(to) } : {}),
              },
            }
          : {}),
      };

      try {
        const [rows, total] = await Promise.all([
          prisma.auditEvent.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
          prisma.auditEvent.count({ where }),
        ]);

        const items = rows.map((r) =>
          AuditEventItem.parse({
            id: r.id,
            actorUserId: r.actorUserId,
            actorTeamId: r.actorTeamId,
            action: r.action,
            resourceType: r.resourceType,
            resourceId: r.resourceId,
            metadata: r.metadata ?? null,
            ipAddress: r.ipAddress ?? null,
            createdAt: r.createdAt.toISOString(),
          }),
        );

        return NextResponse.json(AuditEventList.parse({ items, total, page, pageSize }));
      } catch {
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
      }
    }),
  );
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
