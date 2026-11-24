// @polsia:user-owned — GET /api/dashboard/top-assets.
//
// Top-10 affected-asset envelope for the post-login dashboard: each
// row = one `Asset.host` ranked by raw open-alert count desc
// (the team's unresolved + not-snoozed-active alerts). Reads via
// `loadDashboardTopAssets(teamId)` — server-only selector that
// fires ONE `prisma.alert.findMany` (team + status NOT IN
// {resolved, false_positive} + OR branch on snoozedUntil +
// `findingId: { not: 'manual' }`), narrows `select` to
// `severity + finding.asset.host`, in-app reduces by host with the
// ordinal scoring map, then sorts + slices to the top 10.
//
// Access-control posture mirrors /api/dashboard/trend:
//   - 401 anon / 403 below-member — opaque.
//   - Cross-team leak impossible: the route seeds `teamId` server-
//     side from `workspaceContext.workspaceId` so a tampered URL cannot
//     surface another team's open-alert stream (the route ignores
//     every query-string `teamId` shape because none is read).
//   - Empty-state contract: a team with zero open alerts returns
//     `{ items: [] }` cleanly — `.max(10)` on the schema accepts 0.
//
// Fail-closed: any throw inside the route → 500 JSON.

import 'server-only';
import { NextResponse } from 'next/server';
import { loadDashboardTopAssets } from '@/lib/business/dashboard-top-assets';
import { resolveDashboardWorkspaceContext } from '@/lib/business/dashboard-workspace-context';
import { DashboardTopAssets } from '@/lib/contracts/dashboard';
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
      const result = await loadDashboardTopAssets(workspaceContext.workspaceId);
      return NextResponse.json(DashboardTopAssets.parse(result));
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
