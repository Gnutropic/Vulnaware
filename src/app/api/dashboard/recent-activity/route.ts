// @polsia:user-owned — GET /api/dashboard/recent-activity.
//
// Recent-activity envelope for the post-login dashboard: up to 8
// lifecycle events from the last 7 days across the caller's team.
// Reads via `loadDashboardRecentActivity(teamId)` (server-only
// selector that fires ONE broad `prisma.alert.findMany` over the
// union of three lifecycle-event arms, then merges + sorts + slices).
//
// Access-control posture mirrors /api/alerts/*:
//   - 401 anon / 403 below-member — opaque.
//   - Cross-team leak impossible: the route seeds `teamId` server-
//     side from `workspaceContext.workspaceId` so a tampered URL cannot
//     surface another team's events.
//   - The `take` URL query is intentionally NOT read — the route
//     hard-codes 8 events per request. Future expansion widens the
//     selector rather than wiring a tunable knob at the wire.
//
// Cursor posture: `nextCursor: null` is always stamped on success
// (mirror of `AlertActivityList.nextCursor` at
// src/lib/contracts/alerts.ts:660). A future expansion widens the
// schema to a real paginated timeline; the field is reserved now
// so the client never has to widen the contract.
//
// Fail-closed: any throw inside the route → 500 JSON.

import 'server-only';
import { NextResponse } from 'next/server';
import { loadDashboardRecentActivity } from '@/lib/business/dashboard-recent-activity';
import { resolveDashboardWorkspaceContext } from '@/lib/business/dashboard-workspace-context';
import { DashboardRecentActivity } from '@/lib/contracts/dashboard';
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
      const result = await loadDashboardRecentActivity(workspaceContext.workspaceId);
      return NextResponse.json(DashboardRecentActivity.parse(result));
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
