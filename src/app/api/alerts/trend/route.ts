// @polsia:user-owned — Workspace-scoped CVE velocity trend read API.
// Returns the LATEST VulnerabilityTrend row for the caller's workspace,
// parsed through `AlertTrendLatest`. 404 when no row exists yet for the
// caller's workspace (cold-start before the first jobs/alerts-trend.ts
// tick has run).
//
// Access-control posture:
//   - GET requires `requireTeamRole('member')` — viewers (and below) get
//     403; unauthenticated callers get 401. The route seeds every read
//     with `workspaceId: ctx.membership.teamId` so cross-team leakage is
//     impossible regardless of URL tampering.
//   - No per-id variant — the only read path filters by teamId. There is
//     no other surface that could allow a caller to read a different
//     workspace's row.

import 'server-only';
import { NextResponse } from 'next/server';
import { AlertTrendLatest } from '@/lib/contracts/alerts';
import { prisma } from '@/lib/db';
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

    setRequestAuth({ userId: ctx.user.id, teamId: ctx.membership.teamId });

    try {
      const row = await prisma.vulnerabilityTrend.findFirst({
        where: { workspaceId: ctx.membership.teamId },
        orderBy: { computedAt: 'desc' },
      });
      if (!row) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      // `signal` is stored as Json — `JSON.parse(JSON.stringify(...))`
      // exercises the deep-clone path so a malformed value with a Date
      // embedded surfaces here rather than at zod parse time.
      const signalPlain = JSON.parse(JSON.stringify(row.signal));
      const body = AlertTrendLatest.parse({
        workspaceId: row.workspaceId,
        windowStart: row.windowStart.toISOString(),
        windowEnd: row.windowEnd.toISOString(),
        signal: signalPlain,
        computedAt: row.computedAt.toISOString(),
      });
      return NextResponse.json(body, { status: 200 });
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
