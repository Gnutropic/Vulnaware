// @polsia:user-owned
//
// POST /api/billing/success-verify
// Used by the success-page island:
//   1) Validate `{ sessionId, tier? }` from the success URL + form body.
//      The session id regex `^cs_(test|live)_[A-Za-z0-9]+$` rejects junk
//      / SQL-ish payloads BEFORE we even leave the request from the
//      route — keeps a brute-forcer from hammering the proxy.
//   2) Origin / sec-fetch-site allowlist so a cross-site form post can't
//      drive the redirect through us.
//   3) Call `verifyCheckoutSession` (Polsia proxy) for the canonical
//      verified/{verified:false} result.
//   4) On Pro inferred AND signed-in user → identity-bind the verified
//      payment to the signed-in account:
//        * customer_email on the verified payment must equal user.email
//          (case-insensitive). The proxy returns the buyer's email as
//          they typed it at Stripe; the auth table stores lowercase.
//        * The "verified → who paid?" check is the only practical
//          identity binding, because `verifyCheckoutSession` does NOT
//          echo `metadata.userId`. We DO still attach
//          `metadata: { tier: 'pro', userId: user.id }` at create-time
//          in tier-subscribe so any future `listPaymentEvents`-driven
//          re-derivation has the audit trail.
//   5) Write the UserSubscription row only when both verified === true
//      AND the binding check passed. The Stripe session id's
//      `@unique` constraint blocks cross-user session reuse at the DB
//      layer so the same `cs_*` can't be appended twice.
//   6) Return a discriminated `binding` enum so the success-island
//      branches without ambiguity:
//        - 'verified_and_bound'  → success card + router.refresh()
//        - 'verified_not_bound'  → "this session wasn't paid by your
//                                   account" retry card (binding_reason
//                                   'email_mismatch' or 'anonymous_buyer')
//        - 'verification_failed' → fall through to the poller.
//
// PUBLIC on purpose for the response shape; the side-effect upsert
// only fires when BOTH a verified payment AND a session user match.

import 'server-only';
import { NextResponse } from 'next/server';
import {
  isBrowserNavigationOriginTrusted,
  resolveRequestOriginStrict,
} from '@/lib/business/billing-origin';
import { resolvePricingCatalogEntry } from '@/lib/business/pricing';
import {
  type Binding,
  type BindingReason,
  successVerifyRequestSchema,
  successVerifyResponseSchema,
} from '@/lib/contracts/billing';
import { prisma } from '@/lib/db';
import { withRateLimit } from '@/lib/rate-limit';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import {
  StripeBillingConfigurationError,
  verifyCheckoutSession,
} from '@/lib/stripe-billing/client';

export const dynamic = 'force-dynamic';

async function writeProSubscription(input: {
  userId: string;
  sessionId: string;
  customerEmail: string | null | undefined;
}): Promise<void> {
  await prisma.userSubscription.upsert({
    where: { userId: input.userId },
    create: {
      userId: input.userId,
      tier: 'pro',
      stripeSessionId: input.sessionId,
      stripeCustomerEmail: input.customerEmail ?? null,
      lastVerifiedAt: new Date(),
      active: true,
    },
    update: {
      tier: 'pro',
      stripeSessionId: input.sessionId,
      stripeCustomerEmail: input.customerEmail ?? null,
      lastVerifiedAt: new Date(),
      active: true,
    },
  });
}

// `resolveRequestOriginStrict` is imported so the layer that builds
// the redirect / Stripe success URL elsewhere can share one resolver.
// The success page itself navigates there so the URL we redirect INTO
// is always our own origin — no Origin manipulation can reroute the
// buyer.
void resolveRequestOriginStrict;

export async function POST(req: Request) {
  return withRateLimit(req, async () => runSuccessVerify(req));
}

async function runSuccessVerify(req: Request): Promise<Response> {
  if (!isBrowserNavigationOriginTrusted(req)) {
    return NextResponse.json(
      {
        verified: false,
        binding: 'verification_failed' satisfies Binding,
        binding_reason: 'none' satisfies BindingReason,
        plan: 'unknown',
        error: 'origin_not_allowed',
      },
      { status: 403 },
    );
  }

  const parsed = successVerifyRequestSchema.safeParse(await req.json().catch(() => null));
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

  // Resolve the plan slug from the URL hint + the verified payment's
  // product_name. The Pro catalog row's productName is 'Team
  // subscription'. The `verified === true` branch now only echoes the
  // catalog snippet once we ALSO prove the binding.
  const catalog =
    parsed.data.tier !== undefined ? resolvePricingCatalogEntry(parsed.data.tier) : null;
  const inferredFromProduct = verified.payment.product_name === 'Team subscription' ? 'pro' : null;
  const tierSlug =
    parsed.data.tier ?? (inferredFromProduct as 'pro' | 'starter' | 'enterprise' | null);

  // Anonymous Pro path: catalog says Pro but there's no signed-in user.
  // Translate to `verified_not_bound` so the success-island doesn't
  // render a success card for a buyer whose identity we can't prove
  // tied to the verified session. The reason is the same one used for
  // an email mismatch — we couldn't establish identity binding. The
  // island renders an "this session wasn't paid by your account"
  // message either way.
  if (tierSlug === 'pro') {
    let user: SessionUser;
    try {
      user = await requireAuth(req);
    } catch (res) {
      if (res instanceof Response) {
        return NextResponse.json(
          {
            verified: true,
            binding: 'verified_not_bound' satisfies Binding,
            binding_reason: 'email_mismatch' satisfies BindingReason,
            plan: 'unknown',
            payment: verified.payment,
          },
          { status: 200 },
        );
      }
      throw res;
    }

    const paymentEmail = verified.payment.customer_email?.toLowerCase().trim() ?? null;
    const userEmail = user.email?.toLowerCase().trim() ?? null;
    const emailMatches =
      paymentEmail !== null && paymentEmail.length > 0 && paymentEmail === userEmail;

    if (!emailMatches) {
      return NextResponse.json(
        {
          verified: true,
          binding: 'verified_not_bound' satisfies Binding,
          binding_reason: 'email_mismatch' satisfies BindingReason,
          plan: 'unknown',
          payment: verified.payment,
        },
        { status: 200 },
      );
    }

    // Verified AND bound → write the row, then echo the success shape.
    await writeProSubscription({
      userId: user.id,
      sessionId: parsed.data.sessionId,
      customerEmail: verified.payment.customer_email,
    });

    const payload = successVerifyResponseSchema.parse({
      verified: true,
      binding: 'verified_and_bound' satisfies Binding,
      binding_reason: 'none' satisfies BindingReason,
      plan: 'pro',
      payment: verified.payment,
    });
    return NextResponse.json(payload, { status: 200 });
  }

  // Starter / Enterprise verified branches. These don't write the
  // subscription row (Starter is an immediate write from /pricing;
  // Enterprise is sales motion) — the success-page branch only
  // confirms the verification so the buyer can see the receipt.
  if (tierSlug === 'starter' || tierSlug === 'enterprise') {
    const payload = successVerifyResponseSchema.parse({
      verified: true,
      binding: 'verified_and_bound' satisfies Binding,
      binding_reason: 'none' satisfies BindingReason,
      plan: tierSlug,
      payment: verified.payment,
    });
    return NextResponse.json(payload, { status: 200 });
  }

  // tierSlug is null (catalog miss / non-Pro product_name). Drop
  // through to the unknown branch — the success-island will render
  // the poller fallback.
  void catalog;
  const payload = successVerifyResponseSchema.parse({
    verified: false,
    binding: 'verification_failed' satisfies Binding,
    binding_reason: 'none' satisfies BindingReason,
    plan: 'unknown',
    payment: verified.payment,
  });
  return NextResponse.json(payload, { status: 200 });
}
