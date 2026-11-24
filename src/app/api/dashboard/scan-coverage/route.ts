// @polsia:user-owned — GET /api/dashboard/scan-coverage.
//
// "Scan coverage" envelope for the post-login dashboard: three
// summary numbers — distinct `Alert.finding.asset.host` count on
// the team, the subset of those hosts with at least one open alert,
// and the team's freshest contributing `lastScanActivityAt` stamp.
// Reads via `loadDashboardScanCoverage(teamId)` — server-only
// selector that fires ONE `prisma.alert.findMany` (team + manual-
// row exclusion, narrow `select` joined to `finding.asset.host`)
// and ONE follow-up `computeAlertLastActivityAtForList` peer-read
// to derive the activity stamp.
//
// Access-control posture mirrors /api/dashboard/open-by-severity:
//   - 401 anon / 403 below-member — opaque.
//   - Cross-team leak impossible: the route seeds `teamId` server-
//     side from `workspaceContext.workspaceId`; the route reads no query
//     params so a tampered URL cannot surface another team's
//     coverage counts.
//   - All three fields return non-negative integers / nullable ISO
//     (the contract declares `.nonnegative()` / `.nullable()`
//     accordingly) so a malformed DB read fails the parse loudly
//     instead of silently overflowing the UI.
//
// Fail-closed: any throw inside the route → 500 JSON.

import 'server-only';
import { NextResponse } from 'next/server';
import { loadDashboardScanCoverage } from '@/lib/business/dashboard-scan-coverage';
import { resolveDashboardWorkspaceContext } from '@/lib/business/dashboard-workspace-context';
import { DashboardScanCoverage } from '@/lib/contracts/dashboard';
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
      const result = await loadDashboardScanCoverage(workspaceContext.workspaceId);
      return NextResponse.json(DashboardScanCoverage.parse(result));
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
