// @polsia:user-owned — admin-gated manual trigger for the per-team
// weekly AI-generated risk-trend email digest. Mirrors
// src/app/api/alerts/trend/route.ts shape (same imports, same auth +
// audit + response posture, same `methodNotAllowed` stub for non-POST
// verbs).
//
// Access-control posture:
//   - POST requires `requireTeamRole('admin')`. Viewers / members get
//     403; unauthenticated callers get 401. The route seeds every
//     read/write with `ctx.membership.teamId` so cross-team leakage is
//     impossible regardless of URL tampering.
//   - The route dispatches into the SAME business lib the cron tick
//     uses (`runWeeklyRiskDigestForTeam`), so a manual re-trigger
//     writes a fresh DigestLog row with `triggeredBy='manual'` and the
//     composite (workspaceId, weekStart, triggeredBy) dedupe key keeps
//     the manual insert independent of the cron insert.
//
// Audit:
//   - One `audit()` row per manual trigger, action='digest.manual.trigger'
//     and resourceType='DigestLog' so the trail-of-event UI can surface
//     when an admin fired the digest off-cycle.

import 'server-only';
import { NextResponse } from 'next/server';
import { audit, extractIp } from '@/lib/business/audit';
import { runWeeklyRiskDigestForTeam } from '@/lib/business/weekly-risk-digest';
import { WeeklyDigestRunRequest, WeeklyDigestRunResult } from '@/lib/contracts/digest';
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

    const parsed = WeeklyDigestRunRequest.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'bad_request', issues: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const now = parsed.data.now ? new Date(parsed.data.now) : new Date();
    const appBaseUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');

    let result: Awaited<ReturnType<typeof runWeeklyRiskDigestForTeam>>;
    try {
      result = await runWeeklyRiskDigestForTeam(ctx.membership.teamId, now, {
        triggeredBy: 'manual',
        appBaseUrl,
      });
    } catch {
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }

    // Audit trail — best-effort: a missing audit row never aborts the
    // already-emitted digest, the admin sees the success status either
    // way.
    try {
      await audit({
        actorUserId: ctx.user.id,
        actorTeamId: ctx.membership.teamId,
        action: 'digest.manual.trigger',
        resourceType: 'DigestLog',
        resourceId: result.id ?? 'skipped',
        metadata: {
          sent: result.sent,
          failed: result.failed,
          attempted: result.attempted,
          skipped: result.skipped,
          weekStart: result.weekStart,
        },
        ipAddress: extractIp(req),
      });
    } catch {
      // Audit is observational; the digest envelope is what the user
      // asked for. Don't fail the response because the audit insert
      // raced. A separate deploy log surfaces the skipped audit row.
    }

    // The route returns 200 even when skipped (1 row already in
    // (workspaceId, weekStart, triggeredBy='manual') from a prior
    // tick the SAME admin just hit "Send now"). The island reads
    // `id` and either optimistically prepends a row or surfaces a
    // soft "already sent" toast. We do NOT 4xx a same-week re-trigger
    // — that's the explicit purpose of the button on the admin page.
    const responseBody = WeeklyDigestRunResult.parse({
      id: result.id ?? '',
      attempted: result.attempted,
      sent: result.sent,
      failed: result.failed,
      skipped: result.skipped,
      weekStart: result.weekStart,
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
