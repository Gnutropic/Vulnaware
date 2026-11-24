// @polsia:user-owned — Per-user DevSecOps webhook manager.
//
// GET  /api/account/webhook — return the saved config + last 20 delivery
//        attempts for the caller (`{ url, updatedAt, deliveries }`). The
//        deliveries sub-array drives the delivery-history card under the
//        webhook form on /account.
//
// PUT  /api/account/webhook — upsert the caller's webhook URL. Body shape
//        is `UserWebhookSetBody` (zod): `url` is `string().url().max(2048)
//        .nullable()`. The route adds a field-level HTTPS pre-check so a
//        bare `http://` URL is rejected with a clear 400 — zod's
//        `.url()` happily accepts HTTP, but the brief calls for HTTPS only.
//
// Access-control posture:
//   - Per-user: `requireAuth(req)` (anon → 401). No admin role needed —
//     every authed user saves their OWN webhook.
//   - `setRequestAuth({ userId })` without `teamId`: this is per-user, but
//     `audit()` expects a non-null `actorTeamId` so the audit callsite
//     looks up the caller's Membership.teamId first and stamps that.
//   - The audit row records only action+resource id (never the URL) so
//     the audit log stays scrubbed of secrets — same posture as the team
//     path.

import 'server-only';
import { NextResponse } from 'next/server';
import {
  getUserWebhookConfig,
  getUserWebhookDeliveries,
  upsertUserWebhookUrl,
} from '@/lib/business/account-webhook';
import { audit, extractIp } from '@/lib/business/audit';
import { UserWebhookGetResponse, UserWebhookSetBody } from '@/lib/contracts/account-webhook';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'GET, PUT' } },
  );
}

export async function GET(req: Request) {
  return withApiRequest(req, async () => {
    let user: SessionUser;
    try {
      user = await requireAuth(req);
    } catch (res) {
      return res as Response;
    }
    setRequestAuth({ userId: user.id });

    try {
      const row = await getUserWebhookConfig(user.id);
      const deliveries = await getUserWebhookDeliveries(user.id);
      const response = UserWebhookGetResponse.parse({
        url: row?.webhookUrl ?? null,
        updatedAt: row?.updatedAt.toISOString() ?? new Date(0).toISOString(),
        deliveries: deliveries.map((d) => ({
          id: d.id,
          attemptedAt: d.attemptedAt.toISOString(),
          targetUrl: d.targetUrl,
          payloadKind: d.payloadKind,
          alertId: d.alertId,
          responseCode: d.responseCode,
          latencyMs: d.latencyMs,
          snippet: d.snippet,
        })),
      });
      return NextResponse.json(response);
    } catch {
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  });
}

export async function PUT(req: Request) {
  return withApiRequest(req, async () => {
    let user: SessionUser;
    try {
      user = await requireAuth(req);
    } catch (res) {
      return res as Response;
    }
    setRequestAuth({ userId: user.id });

    let json: unknown;
    try {
      json = await req.json();
    } catch {
      return NextResponse.json({ code: 'bad_request', message: 'invalid JSON' }, { status: 400 });
    }
    const parsed = UserWebhookSetBody.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'bad_request', issues: parsed.error.flatten() },
        { status: 400 },
      );
    }

    // HTTPS pre-check: zod's `.url()` accepts http:// and https://, but the
    // brief requires HTTPS only so an integrator pasting a bare http URL gets
    // a 400 with a clear field-level error — NOT a successful Save that posts
    // to an insecure endpoint. Skip the check on a `null` wipe since there
    // is no URL to validate.
    if (parsed.data.url !== null) {
      try {
        const protocol = new URL(parsed.data.url).protocol;
        if (protocol !== 'https:') {
          return NextResponse.json(
            {
              error: 'bad_request',
              issues: {
                fieldErrors: { url: ['Webhook URL must use HTTPS.'] },
                formErrors: [],
              },
            },
            { status: 400 },
          );
        }
      } catch {
        return NextResponse.json(
          {
            error: 'bad_request',
            issues: {
              fieldErrors: { url: ['Enter a valid HTTPS URL.'] },
              formErrors: [],
            },
          },
          { status: 400 },
        );
      }
    }

    try {
      const row = await upsertUserWebhookUrl({
        userId: user.id,
        url: parsed.data.url,
      });
      // Audit() requires a non-null actorTeamId; resolve it to the user's
      // single team (their Membership) so the operator's audit trail
      // matches the team-scoped listing on /admin/audit. Falls back to the
      // placeholder team for an authed user with no team (the legitimate
      // anonymous-account edge case is silently lost in the team-list view
      // — the audit row still exists, just unattributed to a team).
      const membership = await prisma.membership.findUnique({
        where: { userId: user.id },
        select: { teamId: true },
      });
      void audit({
        actorUserId: user.id,
        actorTeamId: membership?.teamId ?? 'unattributed',
        action: 'user_webhook.set',
        resourceType: 'user_webhook',
        resourceId: row.id,
        // Deliberately exclude the URL here so the audit log never carries
        // the plaintext secret. The hasUrl flag distinguishes "saved an
        // endpoint" from "wiped an endpoint" without exposing the value.
        metadata: { hasUrl: parsed.data.url !== null },
        ipAddress: extractIp(req),
      });
      return NextResponse.json({
        url: row.webhookUrl,
        updatedAt: row.updatedAt.toISOString(),
      });
    } catch {
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  });
}

export const POST = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
