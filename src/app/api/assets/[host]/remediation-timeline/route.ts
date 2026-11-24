// @polsia:user-owned — Per-host remediation timeline feed for
// /assets/[host]. Same posture as
// src/app/api/assets/[host]/route.ts and
// src/app/api/assets/[host]/alerts/route.ts: `requireTeamRole('member')`
// gate, `setRequestAuth` first-call, `withApiRequest` envelope, host
// path-param decode + lowercase + trim + `AssetDetailPathParam` refine.
//
// Why a separate route: the wire envelope shape
// (`{ host, events[], rangeStart, rangeEnd }`) is
// timeline-specific, the underlying query scopes to remediation-shaped
// stamps only (`Alert.remediatedAt IS NOT NULL OR (closedAt IS NOT
// NULL AND status='resolved')`), and a future expansion (severity-
// banded counts, resolve animations) widens it without recomputing
// the AlertItem peer-reads the alerts list already needs.
//
// 200-only posture: the route always emits 200 with the parsed
// envelope. The empty timeline (a host whose alerts are all still
// open) emits `events: []` + `rangeStart: null` + `rangeEnd: null`
// so the client renders an "No remediations yet" empty state rather
// than a 404 shell. The /assets/[host] page already 404s upstream
// when the host has NO contributing alerts, so the timeline section
// is not the surface that decides the page's existence — the timeline
// itself is a soft-fail introspection surface whose worst-case UX is
// an empty state, not a missing page.

import 'server-only';
import { NextResponse } from 'next/server';
import { loadAssetRemediationTimeline } from '@/lib/business/assets-remediation';
import { resolveDashboardWorkspaceContext } from '@/lib/business/dashboard-workspace-context';
import { AssetDetailPathParam, RemediationTimeline } from '@/lib/contracts/assets-remediation';
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
      const data = await loadAssetRemediationTimeline(teamId, parsed.data.host);
      return NextResponse.json(RemediationTimeline.parse(data));
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
