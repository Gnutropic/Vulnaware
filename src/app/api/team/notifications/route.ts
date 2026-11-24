// @polsia:user-owned — Per-team Slack-compatible webhook manager.
//
// GET  /api/team/notifications — returns the team's saved config (null when
//        nothing is saved) plus the last 5 delivery attempts.
//
// POST /api/team/notifications — upsert the team's webhook URL. Body shape
//        is `NotificationSetBody` (zod). The plaintext URL is intentionally
//        echoed back in the response so the UI can render the current value
//        after a Save — the operator sees the same value they typed. The
//        audit row records only action+resource id (never the URL) so the
//        audit log stays scrubbed of secrets.
//
// Access-control posture:
//   - Both verbs call `requireTeamRole('admin')` — single call that resolves
//     user + membership + team. `membership.teamId` seeds every query.
//   - Anon → 401. Non-admin → 403. Missing team → 404. Bad URL → 400.

import 'server-only';
import { NextResponse } from 'next/server';
import { audit, extractIp } from '@/lib/business/audit';
import {
  getTeamNotificationConfig,
  getTeamNotificationDeliveries,
  upsertTeamNotificationUrl,
} from '@/lib/business/team-notifications';
import {
  NotificationConfigItem,
  NotificationGetResponse,
  NotificationSetBody,
} from '@/lib/contracts/team-notifications';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { requireTeamRole } from '@/lib/team-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return withApiRequest(req, async () => {
    let ctx: Awaited<ReturnType<typeof requireTeamRole>>;
    try {
      ctx = await requireTeamRole('admin');
    } catch (res) {
      return res as Response;
    }
    setRequestAuth({ userId: ctx.user.id, teamId: ctx.membership.teamId });

    try {
      const config = await getTeamNotificationConfig(ctx.membership.teamId);
      const deliveries = await getTeamNotificationDeliveries(ctx.membership.teamId);
      const response = NotificationGetResponse.parse({
        config: config
          ? NotificationConfigItem.parse({
              id: config.id,
              teamId: config.teamId,
              webhookUrl: config.webhookUrl,
              createdAt: config.createdAt.toISOString(),
              updatedAt: config.updatedAt.toISOString(),
              createdByUserId: config.createdByUserId,
            })
          : null,
        deliveries: deliveries.map((d) => ({
          id: d.id,
          alertId: d.alertId,
          attemptedAt: d.attemptedAt.toISOString(),
          responseCode: d.responseCode,
          latencyMs: d.latencyMs,
          errorMessage: d.errorMessage,
        })),
      });
      return NextResponse.json(response);
    } catch {
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  });
}

export async function POST(req: Request) {
  return withApiRequest(req, async () => {
    let ctx: Awaited<ReturnType<typeof requireTeamRole>>;
    try {
      ctx = await requireTeamRole('admin');
    } catch (res) {
      return res as Response;
    }
    setRequestAuth({ userId: ctx.user.id, teamId: ctx.membership.teamId });

    let json: unknown;
    try {
      json = await req.json();
    } catch {
      return NextResponse.json({ code: 'bad_request', message: 'invalid JSON' }, { status: 400 });
    }
    const parsed = NotificationSetBody.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'bad_request', issues: parsed.error.flatten() },
        { status: 400 },
      );
    }

    try {
      const row = await upsertTeamNotificationUrl({
        teamId: ctx.membership.teamId,
        url: parsed.data.url,
        actorUserId: ctx.user.id,
      });
      void audit({
        actorUserId: ctx.user.id,
        actorTeamId: ctx.membership.teamId,
        action: 'team_notification.set',
        resourceType: 'team_notification',
        resourceId: row.id,
        // Deliberately exclude the URL here so the audit log never carries
        // the plaintext secret.
        metadata: { teamId: ctx.membership.teamId },
        ipAddress: extractIp(req),
      });
      return NextResponse.json({
        id: row.id,
        teamId: row.teamId,
        webhookUrl: row.webhookUrl,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        createdByUserId: row.createdByUserId,
      });
    } catch {
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  });
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'GET, POST' } },
  );
}

export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
