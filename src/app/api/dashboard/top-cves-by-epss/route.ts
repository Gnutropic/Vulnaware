// @polsia:user-owned — GET /api/dashboard/top-cves-by-epss.
//
// "Top open CVEs by EPSS" envelope for the post-login dashboard:
// the top 8 CVE identifiers ranked by `EPSS` desc across the
// caller's team's currently-open (not-resolved, not-false-positive,
// not-snoozed-active) alerts, with the dominant severity tier and
// the de-duplicated affected-asset count per row. Row link deep-
// targets `/alerts?q=<CVE>`.
//
// Reads via `loadDashboardTopCvesByEpss(teamId)` (server-only
// selector that fires ONE `prisma.alert.findMany` with the open +
// hide-snoozed predicate and a narrow select joined to
// `finding.{cveId, epssScore, severity, asset.host}`, then in-app
// reduces and slices to the top 8).
//
// Access-control posture mirrors /api/dashboard/top-cves:
//   - 401 anon / 403 below-member — opaque.
//   - Cross-team leak impossible: the route seeds `teamId`
//     server-side from `workspaceContext.workspaceId`; the route reads
//     no query params so a tampered URL cannot surface another
//     team's CVE ranking.
//   - Empty-state contract: a team with zero currently-open
//     scripted (non-manual) alerts returns `{ items: [] }` cleanly
//     — `.max(8)` on the schema accepts 0; the client renders
//     "No open CVEs with EPSS data." for that case.
//
// Fail-closed: any throw inside the route → 500 JSON.

import 'server-only';
import { NextResponse } from 'next/server';
import { loadDashboardTopCvesByEpss } from '@/lib/business/dashboard-top-cves-by-epss';
import { resolveDashboardWorkspaceContext } from '@/lib/business/dashboard-workspace-context';
import { DashboardTopCvesByEpss } from '@/lib/contracts/dashboard';
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
      const result = await loadDashboardTopCvesByEpss(workspaceContext.workspaceId);
      return NextResponse.json(DashboardTopCvesByEpss.parse(result));
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
