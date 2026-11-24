// @polsia:user-owned — "Send test" handler for the per-user DevSecOps
// webhook. POSTs a `{ test: true }` body to the caller's saved URL and
// returns the typed outcome so the UI button can render a result row in
// place.
//
// Access control: `requireAuth(req)` — same gate as GET/PUT the config.
// Mirrors the team path's posture: only the user who saved the URL can
// test it.
//
// Failure posture:
//   - 200 OK regardless of upstream outcome (the typed `ok` flag
//     distinguishes success from failure for the UI).
//   - The `no webhook configured` branch returns the same shape as a
//     failed test — the UI's button simply renders that label, the page
//     stays at 200 OK so the saved-empty case is visible without a 503.

import 'server-only';
import { NextResponse } from 'next/server';
import { testUserWebhook } from '@/lib/business/account-webhook';
import { audit, extractIp } from '@/lib/business/audit';
import { UserWebhookTestResponse } from '@/lib/contracts/account-webhook';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'POST' } },
  );
}

export async function POST(req: Request) {
  return withApiRequest(req, async () => {
    let user: SessionUser;
    try {
      user = await requireAuth(req);
    } catch (res) {
      return res as Response;
    }
    setRequestAuth({ userId: user.id });

    try {
      const outcome = await testUserWebhook(user.id);
      const membership = await prisma.membership.findUnique({
        where: { userId: user.id },
        select: { teamId: true },
      });
      void audit({
        actorUserId: user.id,
        actorTeamId: membership?.teamId ?? 'unattributed',
        action: 'user_webhook.test',
        resourceType: 'user_webhook',
        resourceId: user.id,
        metadata: { ok: outcome.ok, status: outcome.status },
        ipAddress: extractIp(req),
      });
      const body = UserWebhookTestResponse.parse({
        ok: outcome.ok,
        status: outcome.status,
        latencyMs: outcome.latencyMs,
        error: outcome.error,
      });
      return NextResponse.json(body, { status: outcome.ok ? 202 : 200 });
    } catch {
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  });
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
