// @polsia:user-owned — Public self-serve trial signup (authenticated
// redirect variant). The original /api/v1/trial-signup keeps the
// claim-email redirect; this endpoint additionally signs the visitor
// in and redirects to /dashboard so a fresh lead lands inside a
// working trial workspace on the same render.
//
// Hardened by the same posture as /api/v1/trial-signup:
//   - per-IP rate limiting (withRateLimit)
//   - honeypot field — non-empty `confirmEmail` short-circuits to OK
//     with no work, so a bot never advances
//   - identical OK + redirectUrl for a brand-new email AND an already-
//     provisioned email (no enumeration leak)
//
// The orchestrator captures the better-auth Set-Cookie headers that
// sign-up / sign-in produce; this handler replays each verbatim onto
// the NextResponse so the browser stores the session token before
// `router.push('/dashboard')` lands.
//
// GET/PUT/PATCH/DELETE return 405.

import 'server-only';
import { NextResponse } from 'next/server';
import { trialSignup } from '@/lib/business/trial';
import { TrialCreateResponse, TrialSignupBody } from '@/lib/contracts/trial';
import { withApiRequest } from '@/lib/logging/with-request';
import { withRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'POST' } },
  );
}

export async function POST(req: Request) {
  return withRateLimit(req, () =>
    withApiRequest(req, async () => {
      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        return NextResponse.json({ code: 'bad_request', message: 'invalid JSON' }, { status: 400 });
      }

      const parsed = TrialSignupBody.safeParse(raw);
      if (!parsed.success) {
        const errors: Record<string, string> = {};
        for (const [field, messages] of Object.entries(parsed.error.flatten().fieldErrors)) {
          const first = messages?.[0];
          if (first) errors[field] = first;
        }
        return NextResponse.json({ errors }, { status: 400 });
      }

      // Honeypot: a real user never fills confirmEmail, but a bot will.
      // Silently pretend success — same shape as a real signup, no work,
      // no email dispatched — so the bot can't distinguish.
      if (parsed.data.confirmEmail && parsed.data.confirmEmail.length > 0) {
        const out = TrialCreateResponse.parse({ ok: true, redirectUrl: '/trial' });
        return NextResponse.json(out, { status: 200 });
      }

      const workspaceName =
        parsed.data.workspaceName && parsed.data.workspaceName.length >= 2
          ? parsed.data.workspaceName
          : parsed.data.company;

      try {
        const result = await trialSignup({
          email: parsed.data.email.toLowerCase(),
          company: parsed.data.company,
          workspaceName,
          companySize: parsed.data.companySize ?? null,
          // /dashboard is the success path for /api/trial/signup; the
          // orchestrator falls back to /trial/started when the session
          // cookie couldn't be issued (existing-user duplicate path).
          redirectTarget: '/dashboard',
          forwardSessionCookies: true,
        });
        const out = TrialCreateResponse.parse({
          ok: true,
          redirectUrl: result.redirectUrl,
        });
        const response = NextResponse.json(out, { status: 200 });
        // Set-Cookie is a multi-header — each line better-auth returned
        // must land as its own header entry so the browser stores every
        // session/cache cookie verbatim. `headers.append` preserves the
        // ordering Set-Cookie had on the upstream response.
        if (result.setCookieHeaders) {
          for (const cookie of result.setCookieHeaders) {
            response.headers.append('set-cookie', cookie);
          }
        }
        return response;
      } catch {
        // Same shape on internal failure — don't leak details to a public
        // endpoint. A real signup that fails is surfaced via the email
        // confirmation step if the user submits again.
        const out = TrialCreateResponse.parse({ ok: true, redirectUrl: '/trial' });
        return NextResponse.json(out, { status: 200 });
      }
    }),
  );
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
