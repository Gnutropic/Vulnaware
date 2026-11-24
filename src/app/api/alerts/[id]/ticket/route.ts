// @polsia:user-owned — POST /api/alerts/[id]/ticket. Operator-facing
// fan-out helper that takes the saved team's notification webhook URL and
// POSTs a Jira-issue-shaped JSON to it ("Open as Jira ticket" button on
// /alerts/[id]).
//
// Re-uses `deliverCriticalNotification` so the resulting delivery row is
// pushed onto the same ring buffer the rescore cron + the test-send button
// write to. That row is what makes the action visible on
// /settings/integrations/notifications. The `payload` arg overrides the
// default Slack-shaped body so the same destination URL can flip between
// transformers without setting a second config.
//
// Access control:
//   - `requireTeamRole('member')` — same posture as `Mark as triaged` /
//     `Set owner`. Any team member can file a Jira ticket; the URL itself
//     is curated on /settings/integrations/notifications by an admin.
//   - `findFirst({ where: { id, teamId } })` collapses cross-team probes
//     into the same opaque 404 as a missing row.
//
// Response posture:
//   - 503 { error: 'no_webhook_configured', ... } — the team's webhook URL
//     slot is empty. The 503 is reserved for this branch; the client uses
//     it as the "navigate them to setup" signal.
//   - 200 { ok: false / true, status, latencyMs, error, delivery } — every
//     other case (including fetch throws and non-2xx upstream). Body is
//     always parseable so the toast renders latency/status inline.

import 'server-only';
import { NextResponse } from 'next/server';
import { requireAlertWorkspaceMember } from '@/lib/business/alert-workspace-access';
import { audit, extractIp } from '@/lib/business/audit';
import { buildJiraPayload, deliverCriticalNotification } from '@/lib/business/team-notifications';
import { AlertTicketResponse } from '@/lib/contracts/alerts';
import { NotificationDeliveryItem } from '@/lib/contracts/team-notifications';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiRequest(req, async () => {
    let ctx: Awaited<ReturnType<typeof requireAlertWorkspaceMember>>;
    try {
      ctx = await requireAlertWorkspaceMember(req);
    } catch (res) {
      return res as Response;
    }

    setRequestAuth({ userId: ctx.user.id, teamId: ctx.workspaceId });

    const { id } = await params;
    const teamId = ctx.workspaceId;

    try {
      // Cross-team opacity check — the `findFirst` is seeded with `teamId`
      // so a wrong-team id resolves the same as a missing row.
      const alertRow = await prisma.alert.findFirst({
        where: { id, teamId },
        select: {
          id: true,
          severity: true,
          finding: {
            select: {
              cveId: true,
              asset: { select: { id: true, host: true, ip: true, port: true, protocol: true } },
              scan: { select: { source: true } },
            },
          },
        },
      });
      if (!alertRow) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      // CveEntry is joined by the free-form `cveId` string column. Re-uses
      // the GET handler's pattern so a missing entry yields an empty
      // description rather than blowing up the parse.
      const cveEntry = alertRow.finding?.cveId
        ? await prisma.cveEntry.findUnique({
            where: { cveId: alertRow.finding.cveId },
            select: { description: true },
          })
        : null;

      const link = `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '')}/alerts/${id}`;
      const cveId = alertRow.finding?.cveId ?? '';
      const severity = alertRow.severity ?? 'unknown';

      // Alert.model has no `title` column — `buildJiraPayload` falls back
      // to the CVE id when the title is empty.
      const jiraPayload = buildJiraPayload({
        alertId: id,
        cveId,
        severity,
        title: '',
        description: cveEntry?.description ?? '',
        asset: {
          host: alertRow.finding?.asset?.host ?? '',
          ip: alertRow.finding?.asset?.ip ?? '',
          port: alertRow.finding?.asset?.port ?? 0,
          protocol: alertRow.finding?.asset?.protocol ?? '',
        },
        link,
      });

      const result = await deliverCriticalNotification({
        teamId,
        alert: {
          alertId: id,
          severity,
          link,
          // Title is intentionally empty — `buildJiraPayload` falls through
          // to `cveId` so Jira never receives a blank `summary`.
          title: '',
        },
        payload: jiraPayload,
      });

      // Pull the most-recent delivery stamp so the client can render the
      // same row shape as the /settings/integrations/notifications list
      // inline. The helper inserts the row synchronously, so a primary-
      // key+attemptedAt-desc lookup is enough.
      const deliveryRow = await prisma.teamNotificationDelivery.findFirst({
        where: { teamId, alertId: id },
        orderBy: { attemptedAt: 'desc' },
      });

      void audit({
        actorUserId: ctx.user.id,
        actorTeamId: ctx.workspaceId,
        action: 'alert.ticket',
        resourceType: 'alert',
        resourceId: id,
        // Mirror the team_notification audit metadata posture — never echo
        // the webhook URL. Status and ok flag are enough to reconstruct
        // the path in audit-log review.
        metadata: { ok: result.ok, status: result.status },
        ipAddress: extractIp(req),
      });

      if (result.error === 'no webhook configured') {
        return NextResponse.json(
          {
            error: 'no_webhook_configured',
            alertId: id,
            delivery: deliveryRow
              ? NotificationDeliveryItem.parse({
                  id: deliveryRow.id,
                  alertId: deliveryRow.alertId,
                  attemptedAt: deliveryRow.attemptedAt.toISOString(),
                  responseCode: deliveryRow.responseCode,
                  latencyMs: deliveryRow.latencyMs,
                  errorMessage: deliveryRow.errorMessage,
                })
              : null,
          },
          { status: 503 },
        );
      }

      const body = AlertTicketResponse.parse({
        ok: result.ok,
        status: result.status,
        latencyMs: result.latencyMs,
        error: result.error,
        delivery: deliveryRow
          ? NotificationDeliveryItem.parse({
              id: deliveryRow.id,
              alertId: deliveryRow.alertId,
              attemptedAt: deliveryRow.attemptedAt.toISOString(),
              responseCode: deliveryRow.responseCode,
              latencyMs: deliveryRow.latencyMs,
              errorMessage: deliveryRow.errorMessage,
            })
          : null,
      });
      return NextResponse.json(body);
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
