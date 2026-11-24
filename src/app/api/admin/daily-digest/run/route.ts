// @polsia:user-owned — Admin-gated manual trigger for the per-team
// 09:00 UTC daily alert digest. Mirrors src/app/api/admin/digest/run/
// route.ts shape (same imports, same auth + audit + response posture,
// same `methodNotAllowed` stub for non-POST verbs).
//
// Access-control posture:
//   - POST requires `requireTeamRole('admin')`. Viewers / members get
//     403; unauthenticated callers get 401. The route seeds every
//     read/write with `ctx.membership.teamId` so cross-team leakage
//     is impossible regardless of URL tampering.
//   - The route dispatches into the per-team orchestrator in
//     `runDailyAlertDigestForTeam`, which uses the SAME business lib
//     the cron tick drives (selector + stamp logic), so a manual
//     re-trigger writes `Team.lastDailyDigestAt` with the same
//     UTC-day stamp semantics.
//
// Audit:
//   - One `audit()` row per manual trigger, action=
//     'daily-digest.manual.trigger' and resourceType='DailyDigestRun'
//     so the trail-of-event UI can surface when an admin fired the
//     daily digest off-cycle.

import 'server-only';
import { NextResponse } from 'next/server';
import { audit, extractIp } from '@/lib/business/audit';
import { runDailyAlertDigestForTeam } from '@/lib/business/daily-alert-digest';
import { DailyDigestRunRequest, DailyDigestRunResult } from '@/lib/contracts/daily-digest';
import { env } from '@/lib/env';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { requireTeamRole } from '@/lib/team-auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return withApiRequest(req, async () => {
    let ctx: Awaited<ReturnType<typeof requireTeamRole>>;
    try {
      ctx = await requireTeamRole('admin');
    } catch (res) {
      return res as Response;
    }

    setRequestAuth({ userId: ctx.user.id, teamId: ctx.membership.teamId });

    let body: unknown = {};
    try {
      const raw = await req.json();
      body = raw ?? {};
    } catch {
      body = {};
    }

    const parsed = DailyDigestRunRequest.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'bad_request', issues: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const now = parsed.data.now ? new Date(parsed.data.now) : new Date();
    const appBaseUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');

    let result: Awaited<ReturnType<typeof runDailyAlertDigestForTeam>>;
    try {
      // `force: true` so the admin button is an explicit re-trigger
      // regardless of the same-day stamp. The route's audit row records
      // the trigger so a re-send can be traced from the trail.
      result = await runDailyAlertDigestForTeam(ctx.membership.teamId, now, {
        triggeredBy: 'manual',
        force: true,
        appBaseUrl,
      });
    } catch {
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }

    // Audit trail — best-effort: a missing audit row never aborts the
    // already-emitted digest, the admin sees the success status either way.
    try {
      await audit({
        actorUserId: ctx.user.id,
        actorTeamId: ctx.membership.teamId,
        action: 'daily-digest.manual.trigger',
        resourceType: 'DailyDigestRun',
        resourceId: result.id ?? 'skipped',
        metadata: {
          sent: result.sent,
          failed: result.failed,
          attempted: result.attempted,
          skipped: result.skipped,
          severityCounts: result.severityCounts,
          windowStartIso: result.windowStartIso,
          windowEndIso: result.windowEndIso,
        },
        ipAddress: extractIp(req),
      });
    } catch {
      // Audit is observational; the digest envelope is what the user
      // asked for. Don't fail the response because the audit insert
      // raced. A separate deploy log surfaces the skipped audit row.
    }

    const responseBody = DailyDigestRunResult.parse({
      id: result.id,
      teamId: result.teamId,
      severityCounts: result.severityCounts,
      attempted: result.attempted,
      sent: result.sent,
      failed: result.failed,
      skipped: result.skipped,
      windowStartIso: result.windowStartIso,
      windowEndIso: result.windowEndIso,
    });
    return NextResponse.json(responseBody, { status: 200 });
  });
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'POST' } },
  );
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
