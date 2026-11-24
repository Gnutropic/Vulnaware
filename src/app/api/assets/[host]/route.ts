// @polsia:user-owned — Per-host asset detail fetch. Used by the
// /assets/[host] page. Mirror posture of src/app/api/assets/route.ts
// (the /assets rollup) and src/app/api/alerts/[id]/route.ts (the alert
// detail) — same `withApiRequest` envelope, same `requireTeamRole('member')`
// gate, same `setRequestAuth` first-call.
//
// Grouping posture differs: /api/assets groups by composite
// `${host}:${port}/${protocol}` (per-probe-arm rollups), this route
// groups by raw `Asset.host` so an operator triaging a noisy host sees
// the cross-probe picture in one place.
//
// URL safety:
//   - `host` is `decodeURIComponent`'d then `.toLowerCase().trim()`'d
//     before the Prisma `where` so a typed `/assets/Foo.Bar` resolves to
//     `foo.bar` (DNS is case-insensitive).
//   - `decodeURIComponent` is wrapped in try/catch so a malformed
//     `%E0%A4%A`-style escape returns 400 rather than crashing the route.
//   - The zod refine on `AssetDetailPathParam` rejects A-Z, 0-9, ":", ".",
//     "_", "-" only — anything else (a `/`, a space, an EM-DASH) 400s.
//
// 404 posture: opaque-not-found. The route returns the literal
// `{ error: 'not_found' }` body for BOTH "no rows" and "wrong team" so
// a cross-team hostname probe can't be distinguished from a missing
// row.

import 'server-only';
import { NextResponse } from 'next/server';
import { loadAssetDetail } from '@/lib/business/assets-detail';
import { resolveDashboardWorkspaceContext } from '@/lib/business/dashboard-workspace-context';
import {
  AssetDetailPathParam,
  AssetDetail as AssetDetailSchema,
} from '@/lib/contracts/assets-detail';
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
      const detail = await loadAssetDetail(teamId, parsed.data.host);

      // 404 for BOTH "no rows on this host" and "the host belongs to a
      // different team" (the latter is a no-op since `where.teamId`
      // narrows server-side, but the opaque posture is the contract).
      // The gate was relaxed from `total === 0 && openCount === 0` to
      // `total === 0` ONLY: a host whose alerts are all remediated or
      // all snoozed still surfaces a populated detail page (with the
      // Remediated / Snoozed count tiles populated) rather than a
      // 404 shell. Pre-relaxation a host with `total > 0 &&
      // openCount === 0` (everything remediated or snoozed) was
      // rejected here, hiding the lifecycle-closed rollup from the
      // operator's triage view.
      if (detail.alerts.total === 0) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      return NextResponse.json(AssetDetailSchema.parse(detail));
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
