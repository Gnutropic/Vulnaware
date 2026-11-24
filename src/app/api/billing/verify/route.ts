// @polsia:user-owned
//
// POST /api/billing/verify
// Auth-gated redacted verify for the BillingVerificationPoller. The route is
// the new POST transport the poller uses after the synchronous success-verify
// returns 'verification_failed' — the success-verify does a first verify right
// out of the page render, but when Stripe's webhook-to-Polsia write hasn't
// landed yet, the poller takes over.
//
// Why a NEW route instead of editing `GET /api/stripe-billing/verify`:
//
//   * That GET is framework-owned (locked by stripe-billing@0.2.0). Editing it
//     fails the validator and we don't WANT to — it's intentionally public, and
//     keeping it that way means any third-party consumer / future cron
//     fulfillment can still call it without a session cookie.
//
//   * `verifyCheckoutSession` returns `payment.customer_email` — exposing
//     that to a polling client that may be authenticated as a DIFFERENT
//     session would let anyone scrape who paid for what. The wrapper
//     asserts `user.email === payment.customer_email` server-side and strips
//     it from the response.
//
//   * The wrapper needs to carry a binding discriminator so the poller can
//     render either the success card, the "wrong account" retry card, or the
//     "still verifying" placeholder, identical to the success-verify
//     response shape (drop-in validation in the island).

import 'server-only';
import { NextResponse } from 'next/server';
import {
  type Binding,
  type BindingReason,
  billingVerifyRequestSchema,
  billingVerifyResponseSchema,
} from '@/lib/contracts/billing';
import { withRateLimit } from '@/lib/rate-limit';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import {
  StripeBillingConfigurationError,
  verifyCheckoutSession,
} from '@/lib/stripe-billing/client';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return withRateLimit(req, async () => runVerify(req));
}

async function runVerify(req: Request): Promise<Response> {
  let user: SessionUser;
  try {
    user = await requireAuth(req);
  } catch (res) {
    return res as Response;
  }

  const parsed = billingVerifyRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        verified: false,
        binding: 'verification_failed' satisfies Binding,
        binding_reason: 'none' satisfies BindingReason,
        plan: 'unknown',
        error: 'invalid_request',
      },
      { status: 400 },
    );
  }

  let verified: Awaited<ReturnType<typeof verifyCheckoutSession>>;
  try {
    verified = await verifyCheckoutSession({ sessionId: parsed.data.sessionId });
  } catch (err) {
    if (err instanceof StripeBillingConfigurationError) {
      return NextResponse.json(
        {
          verified: false,
          binding: 'verification_failed' satisfies Binding,
          binding_reason: 'none' satisfies BindingReason,
          plan: 'unknown',
          error: 'stripe_billing_not_configured',
        },
        { status: 200 },
      );
    }
    return NextResponse.json(
      {
        verified: false,
        binding: 'verification_failed' satisfies Binding,
        binding_reason: 'none' satisfies BindingReason,
        plan: 'unknown',
        error: 'verification_failed',
      },
      { status: 200 },
    );
  }

  if (!verified.verified || !verified.payment) {
    return NextResponse.json(
      {
        verified: false,
        binding: 'verification_failed' satisfies Binding,
        binding_reason: 'none' satisfies BindingReason,
        plan: 'unknown',
        ...(verified.error ? { error: verified.error } : {}),
      },
      { status: 200 },
    );
  }

  // Identity binding — we prove the verified session belongs to the
  // signed-in account. Two failure modes:
  //   * `payment.customer_email` missing → the proxy didn't echo it. We
  //     treat as not bound (the buyer paid, we just can't prove it's THIS
  //     account). The poller renders the "wrong account" retry card.
  //   * `payment.customer_email` present but mismatched → the session was
  //     paid by SOMEONE ELSE. Same retry card.
  //
  // Compare case-insensitively against the user's signed-in email — the
  // user table stores lowercase emails and Stripe hands us whatever the
  // buyer typed.
  const paymentEmail = verified.payment.customer_email?.toLowerCase().trim() ?? null;
  const userEmail = user.email?.toLowerCase().trim() ?? null;
  const bound = paymentEmail !== null && paymentEmail.length > 0 && paymentEmail === userEmail;

  // Resolve the plan slug from the verified payment's product_name against
  // the catalog. The Pro catalog row's productName is 'Team subscription'.
  // The product_name field is exposed on the redacted shape but the
  // catalog decode happens server-side so the response `plan` only ever
  // echoes 'pro' when the buyer is verified AND bound.
  const inferredSlug =
    verified.payment.product_name === 'Team subscription' ? ('pro' as const) : null;
  const plan: 'pro' | 'enterprise' | 'starter' | 'unknown' = bound
    ? (inferredSlug ?? 'unknown')
    : 'unknown';

  const payload = billingVerifyResponseSchema.parse({
    verified: bound,
    binding: bound
      ? ('verified_and_bound' satisfies Binding)
      : ('verified_not_bound' satisfies Binding),
    binding_reason: bound
      ? ('none' satisfies BindingReason)
      : ('email_mismatch' satisfies BindingReason),
    plan,
    product_name: verified.payment.product_name ?? null,
    amount_usd: verified.payment.amount_usd ?? null,
  });
  return NextResponse.json(payload, { status: 200 });
}
