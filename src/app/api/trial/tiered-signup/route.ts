// @polsia:user-owned — Tier-aware public trial signup.
//
// Hardened with the same posture as /api/trial/signup:
//   - per-IP rate limiting (withRateLimit)
//   - honeypot field — non-empty `confirmEmail` short-circuits to the
//     OK envelope with no work performed
//   - identical OK shape for new emails and duplicate-email fallback
//     (no enumeration leak)
//
// The visitor supplies their own password (no claim-link email
// roundtrip like the legacy `TrialSignupBody` flow). On success the
// orchestrator creates Team + Membership (role='admin') +
// WorkspaceMember (role='admin', status='active') + TrialWorkspace
// (planLabel='trial-14d-{tier}') atomically inside a single
// prisma.$transaction.
//
// The orchestrator captures the better-auth Set-Cookie headers from
// sign-up + sign-in; this handler replays each line verbatim onto
// the NextResponse so the browser stores the session token before
// `router.push('/onboarding/welcome')` lands authenticated.
//
// GET/PUT/PATCH/DELETE return 405.

import 'server-only';
import { NextResponse } from 'next/server';
import { tieredTrialSignup } from '@/lib/business/trial';
import { TieredTrialSignupBody, TrialCreateResponse } from '@/lib/contracts/trial';
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

      const parsed = TieredTrialSignupBody.safeParse(raw);
      if (!parsed.success) {
        const errors: Record<string, string> = {};
        for (const [field, messages] of Object.entries(parsed.error.flatten().fieldErrors)) {
          const first = messages?.[0];
          if (first) errors[field] = first;
        }
        return NextResponse.json({ errors }, { status: 400 });
      }

      // Honeypot — same posture as /api/trial/signup. Real users never
      // type into confirmEmail; bots do. Same OK envelope + no work so
      // a bot can't distinguish.
      if (parsed.data.confirmEmail && parsed.data.confirmEmail.length > 0) {
        const out = TrialCreateResponse.parse({
          ok: true,
          redirectUrl: '/onboarding/welcome',
        });
        return NextResponse.json(out, { status: 200 });
      }

      try {
        const result = await tieredTrialSignup({
          email: parsed.data.email,
          password: parsed.data.password,
          workspaceName: parsed.data.workspaceName,
          tier: parsed.data.tier,
        });
        const out = TrialCreateResponse.parse({
          ok: true,
          redirectUrl: result.redirectUrl,
        });
        const response = NextResponse.json(out, { status: 200 });
        if (result.setCookieHeaders) {
          for (const cookie of result.setCookieHeaders) {
            response.headers.append('set-cookie', cookie);
          }
        }
        return response;
      } catch {
        // Same shape on internal failure — don't leak details to a
        // public endpoint. A real signup that fails server-side is
        // rare; the user can retry or contact us.
        const out = TrialCreateResponse.parse({
          ok: true,
          redirectUrl: '/onboarding/welcome',
        });
        return NextResponse.json(out, { status: 200 });
      }
    }),
  );
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
