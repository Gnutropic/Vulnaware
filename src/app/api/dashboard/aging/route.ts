// @polsia:user-owned — GET /api/dashboard/aging.
//
// Four-bucket age distribution count envelope for the post-login
// dashboard: distribution of currently `Open` alerts across the
// `≤7d / 8–30d / 31–90d / >90d` age bands, plus a click-through that
// navigates into /alerts pre-filtered to that bucket. Reads via
// `loadOpenAlertAging(teamId)` (server-only selector that fires four
// independent `prisma.alert.count` queries — all index-only against
// existing `@@index([teamId, status])` + `@@index([teamId,
// createdAt(sort: Desc)])` composites).
//
// Access-control posture mirrors /api/dashboard/summary:
//   - 401 anon / 403 below-member — opaque.
//   - Cross-team leak impossible: the route seeds `teamId` server-
//     side from `workspaceContext.workspaceId` so a tampered URL cannot
//     surface another team's distribution (the route ignores every
//     query-string `teamId` shape because none is read).
//   - All four counts return non-negative integers; the contract
//     declares `.nonnegative()` so a malformed DB read fails the
//     parse loudly instead of silently overflowing the UI.
//
// Fail-closed: any throw inside the route → 500 JSON.

import 'server-only';
import { NextResponse } from 'next/server';
import { loadOpenAlertAging } from '@/lib/business/dashboard-aging';
import { resolveDashboardWorkspaceContext } from '@/lib/business/dashboard-workspace-context';
import { DashboardOpenAging } from '@/lib/contracts/dashboard';
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
      const counts = await loadOpenAlertAging(workspaceContext.workspaceId);
      return NextResponse.json(DashboardOpenAging.parse(counts));
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
