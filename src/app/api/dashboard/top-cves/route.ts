// @polsia:user-owned — GET /api/dashboard/top-cves.
//
// "Top recurring CVEs" envelope for the post-login dashboard: the
// top 5 CVE identifiers ranked by total occurrence across the
// caller's team — currently-open (hide-snoozed default) AND
// recently-closed rows (last 7d) — with a per-row severity
// mix and a deep-link to `/alerts?q=<CVE>`. Recently-closed now
// reads either `remediatedAt` OR `closedAt` (the new
// closure-event widening so a resolve-stamp-only row still
// surfaces; mirror of the MTTR tile's `remediatedAt ?? closedAt`
// closure-event semantics). Reads via
// `loadDashboardTopCves(teamId)` (server-only selector that fires
// ONE `prisma.alert.findMany` with OR-ed open + recently-closed
// predicates and a narrow `select` joined to `finding.cveId`, then
// in-app reduces and slices to the top 5).
//
// Access-control posture mirrors /api/dashboard/recent-remediations:
//   - 401 anon / 403 below-member — opaque.
//   - Cross-team leak impossible: the route seeds `teamId` server-
//     side from `workspaceContext.workspaceId`; the route reads no query
//     params so a tampered URL cannot surface another team's CVE
//     ranking.
//   - Empty-state contract: a team with zero contributing alerts
//     returns `{ items: [] }` cleanly — `.max(5)` on the schema
//     accepts 0; the client renders "No recurring CVEs in the last
//     7 days." for that case.
//
// Fail-closed: any throw inside the route → 500 JSON.

import 'server-only';
import { NextResponse } from 'next/server';
import { loadDashboardTopCves } from '@/lib/business/dashboard-top-cves';
import { resolveDashboardWorkspaceContext } from '@/lib/business/dashboard-workspace-context';
import { DashboardTopCves } from '@/lib/contracts/dashboard';
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
      const result = await loadDashboardTopCves(workspaceContext.workspaceId);
      return NextResponse.json(DashboardTopCves.parse(result));
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
