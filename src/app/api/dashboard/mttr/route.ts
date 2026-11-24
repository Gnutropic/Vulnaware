// @polsia:user-owned — GET /api/dashboard/mttr.
//
// "Mean time to remediate" envelope for the post-login dashboard:
// arithmetic mean of `(closureEvent − Alert.createdAt)` across the
// team's closed-row closure events inside two adjacent 30-day
// windows (current + prior baseline), where
// `closureEvent = Alert.remediatedAt ?? Alert.closedAt`. Reads via
// `loadDashboardMttr(teamId)` — server-only selector that fires
// FOUR `prisma.alert.findMany` calls (two windows × two closure
// columns: remediatedAt + closedAt), narrows `select` to
// `{id, createdAt, remediatedAt, closedAt}` only, dedupes rows
// that surface in BOTH the remediated-At AND closed-At arms, and
// reduces the per-row deltas into a JS-side mean. The widening
// from the prior `remediatedAt`-only reading picks up rows the
// team resolved without first stamping "Mark as remediated" —
// they're just as much "the team acted" as the stamped ones, and
// dropping them silently would under-state the team's mean
// response time.
//
// Access-control posture mirrors /api/dashboard/recent-remediations:
//   - 401 anon / 403 below-member — opaque.
//   - Cross-team leak impossible: the route seeds `teamId` server-
//     side from `workspaceContext.workspaceId`; the route reads no query
//     params so a tampered URL cannot surface another team's MTTR.
//   - The HTTP 200 envelope shape is `{ mttrMs, priorMttrMs,
//     sampleSize }` (nullable partner on the two means). A team
//     with zero remediated alerts returns `{ mttrMs: null,
//     priorMttrMs: null, sampleSize: 0 }` cleanly — the client
//     renders `—" / "no prior baseline"` for that case.
//
// Fail-closed: any throw inside the route → 500 JSON.

import 'server-only';
import { NextResponse } from 'next/server';
import { loadDashboardMttr } from '@/lib/business/dashboard-mttr';
import { resolveDashboardWorkspaceContext } from '@/lib/business/dashboard-workspace-context';
import { DashboardMttr } from '@/lib/contracts/dashboard';
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
      const result = await loadDashboardMttr(workspaceContext.workspaceId);
      return NextResponse.json(DashboardMttr.parse(result));
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
