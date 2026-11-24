// @polsia:user-owned — GET /api/dashboard/recent-remediations.
//
// "Recent remediations" envelope for the post-login dashboard: the
// last 5 alerts on the caller's team with a non-null
// `Alert.remediatedAt`, ordered by `remediatedAt desc`, with
// future-snoozed rows excluded (mirror of /api/alerts's hide-
// snoozed posture). Reads via
// `loadDashboardRecentRemediations(teamId)` — server-only selector
// that fires ONE `prisma.alert.findMany` (team + remediatedAt not
// null + snooze OR-exclusion), narrows `select` to a handful of
// columns + the joined `finding.cveId`, then a single batched
// `prisma.workspaceMember.findMany` resolves per-row owner email.
//
// Access-control posture mirrors /api/dashboard/top-assets:
//   - 401 anon / 403 below-member — opaque.
//   - Cross-team leak impossible: the route seeds `teamId` server-
//     side from `workspaceContext.workspaceId` so a tampered URL cannot
//     surface another team's remediation stream (the route ignores
//     every query-string `teamId` shape because none is read).
//   - Empty-state contract: a team with zero remediated alerts
//     returns `{ items: [] }` cleanly — `.max(5)` on the schema
//     accepts 0; the client renders "No remediations yet." for
//     that case.
//
// Fail-closed: any throw inside the route → 500 JSON.

import 'server-only';
import { NextResponse } from 'next/server';
import { loadDashboardRecentRemediations } from '@/lib/business/dashboard-recent-remediations';
import { resolveDashboardWorkspaceContext } from '@/lib/business/dashboard-workspace-context';
import { DashboardRecentRemediations } from '@/lib/contracts/dashboard';
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
      const result = await loadDashboardRecentRemediations(workspaceContext.workspaceId);
      return NextResponse.json(DashboardRecentRemediations.parse(result));
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
