// @polsia:user-owned — Per-host risk-score trend feed for
// /assets/[host]. Same posture as the sibling remediation-timeline
// route at the same path-prefix:
//   - `requireTeamRole('member')` gate + `setRequestAuth`
//     first-call (member-scope; the trend is enforced to the
//     caller's team so a probe cannot surface another team's risk
//     shape).
//   - `withApiRequest` envelope.
//   - host path-param decode + lowercase + trim + the same
//     `AssetDetailPathParam` refine the /assets/[host] route and
//     sibling endpoints use.
//   - `dynamic = 'force-dynamic'` so the redirect posture from
//     the (dashboard) Server-Component for /assets/[host] lands
//     on a fresh read on every visit.
//
// The response contains one point per scan with a persisted finding score.
// Hosts with no scored scans in the trailing 30-day window return
// `{ host, series: [] }` with HTTP 200 so the client can render its empty state.

import 'server-only';
import { NextResponse } from 'next/server';
import { loadAssetRiskTrend } from '@/lib/business/assets-risk-trend';
import { resolveDashboardWorkspaceContext } from '@/lib/business/dashboard-workspace-context';
import {
  AssetDetailPathParam,
  AssetRiskTrend,
  type AssetRiskTrend as AssetRiskTrendData,
} from '@/lib/contracts/assets-risk-trend';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { requireTeamRole } from '@/lib/team-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ host: string }> }) {
  return withApiRequest(req, async () => {
    let ctx: Awaited<ReturnType<typeof requireTeamRole>>;
    try {
      ctx = await requireTeamRole('member');
    } catch (res) {
      return res as Response;
    }
    const workspaceContext = await resolveDashboardWorkspaceContext(ctx.user.id);
    if (!workspaceContext) {
      return NextResponse.json({ error: 'No active workspace' }, { status: 404 });
    }
    setRequestAuth({ userId: ctx.user.id, teamId: workspaceContext.workspaceId });

    const rawParams = await params;
    let decodedHost: string;
    try {
      decodedHost = decodeURIComponent(rawParams.host);
    } catch {
      return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    }
    const normalizedHost = decodedHost.toLowerCase().trim();

    const parsed = AssetDetailPathParam.safeParse({ host: normalizedHost });
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'bad_request', issues: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const teamId = workspaceContext.workspaceId;
    try {
      const data: AssetRiskTrendData = await loadAssetRiskTrend(
        teamId,
        parsed.data.host,
        new Date(),
      );
      return NextResponse.json(AssetRiskTrend.parse(data));
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
