// @polsia:user-owned — GET /api/dashboard/summary.
//
// Four-tile count envelope for the post-login dashboard:
// `Unresolved alerts / Owned by me / Snoozed / Resolved this week`. Reads via
// `loadDashboardSummary(teamId, memberId)` (server-only selector
// that fires four `prisma.alert.count` queries — all index-only
// against existing `@@index([teamId, ...])` composites).
//
// Access-control posture mirrors /api/alerts/*:
//   - 401 anon / 403 below-member — opaque.
//   - Cross-team leak impossible: the route seeds `teamId` server-
//     side from `workspaceContext.workspaceId` so a tampered URL cannot
//     surface another team's counts (the route ignores every
//     query-string `teamId` shape because none is read).
//   - All four counts return non-negative integers; the contract
//     declares `.nonnegative()` so a malformed DB read fails the
//     parse loudly instead of silently overflowing the UI.
//
// Fail-closed: any throw inside the route → 500 JSON.

import 'server-only';
import { NextResponse } from 'next/server';
import { loadDashboardSummary } from '@/lib/business/dashboard-summary';
import { resolveDashboardWorkspaceContext } from '@/lib/business/dashboard-workspace-context';
import { DashboardSummary } from '@/lib/contracts/dashboard';
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
      const counts = await loadDashboardSummary(
        workspaceContext.workspaceId,
        workspaceContext.workspaceMemberId,
      );
      return NextResponse.json(DashboardSummary.parse(counts));
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
