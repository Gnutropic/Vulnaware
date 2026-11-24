// @polsia:user-owned — GET /api/dashboard/open-by-severity.
//
// Four-severity open-alert count envelope for the post-login dashboard
// "Open by severity" tile. Each cell is a click-through that navigates
// into /alerts pre-filtered to its severity. Reads via
// `loadOpenAlertCountsBySeverity(teamId)` (server-only selector that
// fires one prisma `groupBy` — index-only against existing
// `@@index([teamId, status])` / `@@index([teamId, remediatedAt])` /
// `@@index([teamId, snoozedUntil])` composites).
//
// Access-control posture mirrors /api/dashboard/summary:
//   - 401 anon / 403 below-member — opaque.
//   - Cross-team leak impossible: the route seeds `teamId` server-
//     side from `workspaceContext.workspaceId` so a tampered URL cannot
//     surface another team's distribution.
//   - All four counts return non-negative integers; the contract
//     declares `.nonnegative()` so a malformed DB read fails the
//     parse loudly instead of silently overflowing the UI.
//
// Fail-closed: any throw inside the route → 500 JSON.

import 'server-only';
import { NextResponse } from 'next/server';
import { loadOpenAlertCountsBySeverity } from '@/lib/business/dashboard-open-by-severity';
import { resolveDashboardWorkspaceContext } from '@/lib/business/dashboard-workspace-context';
import { DashboardOpenBySeverityCounts } from '@/lib/contracts/dashboard';
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
      const counts = await loadOpenAlertCountsBySeverity(workspaceContext.workspaceId);
      return NextResponse.json(DashboardOpenBySeverityCounts.parse(counts));
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
