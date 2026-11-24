// @polsia:user-owned — POST /api/alerts/snooze-digest. Compiles a snooze
// digest for the calling user and emails it through the installed email
// module. POST (NOT a server action — Server Actions are banned by the
// platform build gate; the data plane uses REST + apiFetch). Sister to
// /api/alerts/[id]/snooze which writes the per-row snooze stamped window
// the digest summarises.
//
// Body contract: empty `{}` body. The route ignores any inbound
// payload — there is no selection, no filter, and no `duration`/`until`
// to stamp at this layer. (Optional: a future revision could surface
// `groups` or `appBaseUrl` from the body, but the brief keeps it
// server-stamped end-to-end so a client can't fabricate a target
// recipient or obfuscate the per-day buckets.)
//
// Access-control: gated by `requireTeamRole('member')` — same posture
// the per-row `/api/alerts/[id]/snooze` route takes. A solo-tier
// workspace that hasn't bootstrapped membership gets a 404 via
// `requireTeamRead`'s "No team" envelope (parity with the snooze POST
// + bulk snooze routes). The 401 path stays gated by `requireAuth`.
// Anonymous 401 vs. wrong-team 403 vs. no-team 404 → all opaque per
// the post-narrow posture. A 401 in the `requireAuth` branch
// (anonymous) is the only branch that returns a 401 envelope —
// the cross-team branch never returns a 404 with a written id.
//
// Response shapes:
//   - 200 `{ sent: true,  totalAlerts: N }` on send success
//   - 200 `{ sent: false, reason: 'no_snoozed', totalAlerts: 0 }`
//     when the caller is gated-but-has-no-team-row or has no
//     matching alerts. No envelope sent (saves the proxy's 50/day
//     rate limit on accidental double-clicks).
//   - 200 `{ sent: false, reason: 'no_email', totalAlerts: N }` on
//     `User.email` miss (defensive — better-auth default seeds one).
//   - 502 `{ error: 'send_failed' }` when `sendEmail` throws
//     (proxy cold-fail or 5xx). The proxy-bound `result.id` is
//     informational; the route treats a thrown error as failure.
//   - 500 JSON on any unexpected throw inside the handler.
//
// 405 stubs mirror /api/alerts/[id]/snooze/route.ts:184-192 so a
// stale GET / PUT / PATCH / DELETE branch returns the same
// `{ code: 'method_not_allowed' }` envelope as the per-row routes.

import 'server-only';
import { NextResponse } from 'next/server';
import { findSnoozeDigestInput, sendSnoozeDigestToUser } from '@/lib/business/snooze-digest';
import { env } from '@/lib/env';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { requireTeamRole } from '@/lib/team-auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return withApiRequest(req, async () => {
    let ctx: Awaited<ReturnType<typeof requireTeamRole>>;
    try {
      ctx = await requireTeamRole('member');
    } catch (res) {
      return res as Response;
    }

    setRequestAuth({ userId: ctx.user.id, teamId: ctx.membership.teamId });

    try {
      const now = new Date();
      const appBaseUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');
      const payload = await findSnoozeDigestInput(ctx.user.id, now, appBaseUrl);
      if (payload === null) {
        return NextResponse.json({ error: 'no_team' }, { status: 404 });
      }

      if (!ctx.user.email) {
        // Defensive: requireAuth's session shape returns a typed
        // User — the route relies on `requireAuth`'s narrower claim
        // here, but the email-address column on User is opted-out
        // for non-Google signups. Treat the email-less case as the
        // same no-op as the no-snoozed branch so we never hit the
        // proxy's 50/day on a missing recipient.
        return NextResponse.json(
          { sent: false, reason: 'no_email', totalAlerts: payload.totalAlerts },
          { status: 200 },
        );
      }

      if (payload.totalAlerts === 0 || payload.groups.length === 0) {
        return NextResponse.json(
          { sent: false, reason: 'no_snoozed', totalAlerts: 0 },
          { status: 200 },
        );
      }

      const result = await sendSnoozeDigestToUser(payload, now, { appBaseUrl });
      if (!result.sent && result.reason === 'send_failed') {
        return NextResponse.json(
          { error: 'send_failed', totalAlerts: result.totalAlerts },
          { status: 502 },
        );
      }
      return NextResponse.json(
        {
          sent: result.sent,
          totalAlerts: result.totalAlerts,
          ...(result.reason ? { reason: result.reason } : {}),
        },
        { status: 200 },
      );
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
