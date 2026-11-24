// @polsia:user-owned — Per-CVE velocity trend read API. Sister surface to
// GET /api/alerts/trend — instead of the workspace-wide signal, returns
// the per-CVE (recent, prior) counts + velocity for ONE cveId, gated
// through the workspace's latest VulnerabilityTrend.acceleratingIncreases
// list. The detail page at /alerts/trend/[cveId] reads from here.
//
// Access-control posture:
//   - GET requires `requireTeamRole('member')`; below-member → 403,
//     unauthenticated → 401.
//   - The route seeds every read with `workspaceId:
//     ctx.membership.teamId` so cross-team leakage is impossible
//     regardless of URL tampering. The cveId is a CVE id (a publicly
//     scoped identifier) and is the only path parameter — it is safe
//     to read from URL.
//
// 404 when no trend row exists yet for the caller's workspace OR when
// the requested CVE is NOT in `acceleratingIncreases` (i.e. the trend
// signal doesn't have it as currently accelerating). The two cases
// are intentionally collapsed into one 404: the detail page surfaces
// "this CVE is not currently trending" without distinguishing
// cold-start from cold-trend, since either way the answer is "no
// per-CVE detail to show."

import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AlertTrendDetail, VelocityTrendSignal } from '@/lib/contracts/alerts';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { requireTeamRole } from '@/lib/team-auth';

export const dynamic = 'force-dynamic';

// 30 / 60 day windows, mirror src/lib/business/alerts-trend.ts.
const THIRTY_DAYS_MS = 30 * 86_400_000;
const SIXTY_DAYS_MS = 60 * 86_400_000;

const CveIdParam = z
  .string()
  .trim()
  .min(1)
  .max(200)
  // CVE ids are typically `CVE-YYYY-NNNN` but accept any non-empty
  // string that survives zod — a malformed value will simply fail
  // the membership check below and 404 out as "not accelerating".
  .regex(/^[A-Za-z0-9._:-]+$/, 'invalid cveId');

function windowOf(now: Date): { windowStart: Date; windowEnd: Date } {
  return { windowStart: new Date(now.getTime() - THIRTY_DAYS_MS), windowEnd: now };
}

function priorWindow(now: Date): { windowStart: Date; windowEnd: Date } {
  const end = new Date(now.getTime() - THIRTY_DAYS_MS);
  const start = new Date(now.getTime() - SIXTY_DAYS_MS);
  return { windowStart: start, windowEnd: end };
}

export async function GET(
  req: Request,
  // Next.js App Router requires the second arg with the dynamic
  // segment — we read `cveId` off `params.cveId` after zod-validating
  // it. URL-driven but treated as an untrusted string.
  context: { params: Promise<{ cveId: string }> },
) {
  return withApiRequest(req, async () => {
    let ctx: Awaited<ReturnType<typeof requireTeamRole>>;
    try {
      ctx = await requireTeamRole('member');
    } catch (res) {
      return res as Response;
    }

    setRequestAuth({ userId: ctx.user.id, teamId: ctx.membership.teamId });

    const { cveId: rawCveId } = await context.params;
    const parsedCveId = CveIdParam.safeParse(rawCveId);
    if (!parsedCveId.success) {
      return NextResponse.json(
        { error: 'bad_request', issues: parsedCveId.error.flatten() },
        { status: 400 },
      );
    }
    const cveId = parsedCveId.data;

    try {
      const now = new Date();
      const recent = windowOf(now);
      const prior = priorWindow(now);

      // Latest trend row for the caller's workspace. Same index scan as
      // /api/alerts/trend and the new /api/alerts stamp.
      const row = await prisma.vulnerabilityTrend.findFirst({
        where: { workspaceId: ctx.membership.teamId },
        orderBy: { computedAt: 'desc' },
      });
      if (!row) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      // Deep-clone + zod-validate the stored JSON so a schema drift
      // surfaces here rather than in the per-CVE counts. The
      // `acceleratingIncreases` list defaults to `[]` via the
      // contract, so back-compat rows parse cleanly.
      const signalPlain = JSON.parse(JSON.stringify(row.signal));
      const signal = VelocityTrendSignal.parse(signalPlain);
      if (!signal.acceleratingIncreases.includes(cveId)) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      // Per-CVE counts: two batched `Alert.count` reads scoped by
      // (teamId, createdAt window, finding.cveId). The finding join
      // goes via the existing Alert.findingId FK; combined with the
      // (teamId, createdAt desc) index, both reads stay on indexed
      // slices. Returns 0 / 0 if somehow the CVE is no longer present
      // (race with cron) — the wire shape is stable either way.
      const [recentCount, priorCount] = await Promise.all([
        prisma.alert.count({
          where: {
            teamId: ctx.membership.teamId,
            createdAt: { gte: recent.windowStart, lt: recent.windowEnd },
            finding: { cveId },
          },
        }),
        prisma.alert.count({
          where: {
            teamId: ctx.membership.teamId,
            createdAt: { gte: prior.windowStart, lt: prior.windowEnd },
            finding: { cveId },
          },
        }),
      ]);

      const body = AlertTrendDetail.parse({
        workspaceId: row.workspaceId,
        cveId,
        velocity: recentCount - priorCount,
        recentCount,
        priorCount,
        acceleratingIncreases: signal.acceleratingIncreases,
        windowStart: row.windowStart.toISOString(),
        windowEnd: row.windowEnd.toISOString(),
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
