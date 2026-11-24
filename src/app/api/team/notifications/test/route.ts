// @polsia:user-owned — "Send test alert" handler. Reads the team's saved
// config, posts a synthetic critical payload to the configured Slack-compatible
// URL, records the attempt in the same ring buffer the live fan-out writes
// to, and returns a typed outcome for the button.
//
// This is the operator's "is my webhook URL actually reachable" affordance:
// one click posts a known payload and surfaces the upstream status + latency
// inline on the page.
//
// Access control: `requireTeamRole('admin')` — same gate as GET/POST the
// config. Matches the brief's "admin's path to fan" posture: only admins
// can save a URL, only admins can hit Test.
//
// Response shape:
//   - 202 Accepted when the upstream responded 2xx.
//   - 200 OK when called (regardless of upstream outcome) so the typed body
//     is parseable; `ok` distinguishes success from failure for the UI.
//   - 503 Service Unavailable when no config is saved yet — the test is
//     meaningless without one.

import 'server-only';
import { NextResponse } from 'next/server';
import { audit, extractIp } from '@/lib/business/audit';
import { testTeamNotification } from '@/lib/business/team-notifications';
import { NotificationTestResponse } from '@/lib/contracts/team-notifications';
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

    try {
      const outcome = await testTeamNotification(ctx.membership.teamId);
      if (outcome.error === 'no webhook configured' && outcome.status == null) {
        return NextResponse.json({ error: 'no_webhook_configured' }, { status: 503 });
      }
      void audit({
        actorUserId: ctx.user.id,
        actorTeamId: ctx.membership.teamId,
        action: 'team_notification.test',
        resourceType: 'team_notification',
        resourceId: ctx.membership.teamId,
        metadata: { ok: outcome.ok, status: outcome.status },
        ipAddress: extractIp(req),
      });
      const body = NotificationTestResponse.parse({
        ok: outcome.ok,
        status: outcome.status ?? null,
        latencyMs: outcome.latencyMs,
        error: outcome.error,
      });
      return NextResponse.json(body, { status: outcome.ok ? 202 : 200 });
    } catch {
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
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
