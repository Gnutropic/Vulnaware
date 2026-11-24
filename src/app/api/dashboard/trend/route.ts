// @polsia:user-owned — GET /api/dashboard/trend.
//
// Last-14-days alert-volume envelope for the post-login dashboard:
// raw event rows (created + closed) inside the 14d window for the
// caller's team, so the client can bucket by LOCAL day without
// server-side timestamp drift. Reads via
// `loadDashboardAlertTrend(teamId)` (server-only selector that
// fires ONE `prisma.alert.findMany` over the union of the
// `createdAt` and `closedAt` arms, narrow `select`, bounded
// `take: 5000`).
//
// Access-control posture mirrors /api/dashboard/aging:
//   - 401 anon / 403 below-member — opaque.
//   - Cross-team leak impossible: the route seeds `teamId` server-
//     side from `workspaceContext.workspaceId` so a tampered URL cannot
//     surface another team's event stream (the route ignores
//     every query-string `teamId` shape because none is read).
//   - ISO timestamps stamped `at` from Prisma's `Date` shape so
//     a client serialization drift (`new Date('invalid').toJSON()`
//     may yield `null`) fails the parse loudly.
//
// Fail-closed: any throw inside the route → 500 JSON.

import 'server-only';
import { NextResponse } from 'next/server';
import { loadDashboardAlertTrend } from '@/lib/business/dashboard-alert-trend';
import { resolveDashboardWorkspaceContext } from '@/lib/business/dashboard-workspace-context';
import { DashboardTrend } from '@/lib/contracts/dashboard';
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

    try {
      const workspaceContext = await resolveDashboardWorkspaceContext(ctx.user.id);
      if (!workspaceContext) {
        return NextResponse.json({ error: 'No active workspace' }, { status: 404 });
      }

      setRequestAuth({ userId: ctx.user.id, teamId: workspaceContext.workspaceId });
      const result = await loadDashboardAlertTrend(workspaceContext.workspaceId);
      // Stamp ISO strings for the wire — keeps the contract
      // JSON-only so the client never receives a `Date` object.
      const payload = {
        events: result.events.map((e) => ({
          id: e.id,
          createdAt: e.createdAt.toISOString(),
          closedAt: e.closedAt ? e.closedAt.toISOString() : null,
        })),
      };
      return NextResponse.json(DashboardTrend.parse(payload));
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
