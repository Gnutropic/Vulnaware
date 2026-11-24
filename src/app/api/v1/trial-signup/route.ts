// @polsia:user-owned — Public self-serve trial signup.
//
// POST /api/v1/trial-signup — conversion surface, intentionally
// unauthenticated. Hardened by:
//   - per-IP rate limiting (withRateLimit)
//   - honeypot field — non-empty `confirmEmail` short-circuits to OK
//     with no work, so a bot never advances
//   - identical OK + redirectUrl for a brand-new email AND an already-
//     provisioned email (no enumeration leak)
//   - trialSignup business logic uses server-generated random
//     passwords and scrypt-hashed claim tokens so the welcome email
//     is a single-use secret.
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
        });
        const out = TrialCreateResponse.parse({
          ok: true,
          redirectUrl: result.redirectUrl,
        });
        return NextResponse.json(out, { status: 200 });
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
