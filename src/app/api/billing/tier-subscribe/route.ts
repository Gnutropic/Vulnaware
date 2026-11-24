// @polsia:user-owned
//
// POST /api/billing/tier-subscribe
// Per-tier button on /pricing. Body `{ tier: 'starter' | 'pro' | 'enterprise' }`;
// the server resolves the catalog entry in src/lib/business/pricing.ts
// and branches on `kind`:
//
//   * 'stripe' (Pro) — signed-in users get `customerEmail: user.email`
//     and `metadata: { tier: 'pro', userId: user.id }` attached to
//     `createCheckoutSession` so any later `verifyCheckoutSession` /
//     `listPaymentEvents` re-derivation can identity-bind the payment
//     to the account. ANONYMOUS Pro callers get `binding_required`
//     so the page routes them to /signup?tier=pro before Stripe ever
//     sees them — defence in depth.
//   * 'free' (Starter) — auth-gated immediate write. `requireAuth` is
//     called INSIDE the `free` branch: a logged-out buyer gets
//     `{ kind: 'free', redirect: '/signup?tier=starter' }` so the
//     island can route them to signup with the intent preserved.
//     A signed-in buyer gets a fresh UserSubscription { tier:'starter' }
//     row written and `{ kind: 'free', redirect: '/dashboard' }`.
//   * 'contact' (Enterprise) — return the contact-form URL with the
//     `?plan=enterprise` slug intact. No row write this turn; sales
//     motion stays human-in-loop.
//
// All three financial branches share:
//   - Origin / sec-fetch-site allowlist (`isBrowserNavigationOriginTrusted`)
//   - `withRateLimit` bucket around the inner handler.
//
// The Pro branch also includes the no-inbound-webhook comment block from
// the audit matrix: events from Stripe arrive via `listPaymentEvents` ONLY;
// there is no `/api/webhooks/stripe` and adding one is forbidden by the
// stripe-payments + stripe-billing modules.

import 'server-only';
import { NextResponse } from 'next/server';
import {
  isBrowserNavigationOriginTrusted,
  resolveRequestOriginStrict,
} from '@/lib/business/billing-origin';
import { resolvePricingCatalogEntry } from '@/lib/business/pricing';
import { tierSubscribeRequestSchema } from '@/lib/contracts/billing';
import { prisma } from '@/lib/db';
import { withRateLimit } from '@/lib/rate-limit';
import { getSessionUser } from '@/lib/require-auth';
import {
  createCheckoutSession,
  StripeBillingConfigurationError,
  StripeBillingNotEnabledError,
  StripeBillingOnboardingError,
} from '@/lib/stripe-billing/client';

export const dynamic = 'force-dynamic';

async function writeStarterSubscription(userId: string): Promise<void> {
  await prisma.userSubscription.upsert({
    where: { userId },
    create: { userId, tier: 'starter', active: true, lastVerifiedAt: new Date() },
    update: { tier: 'starter', stripeSessionId: null, active: true, lastVerifiedAt: new Date() },
  });
}

export async function POST(req: Request) {
  return withRateLimit(req, async () => runTierSubscribe(req));
}

async function runTierSubscribe(req: Request): Promise<Response> {
  if (!isBrowserNavigationOriginTrusted(req)) {
    return NextResponse.json({ error: 'origin_not_allowed' }, { status: 403 });
  }

  const parsed = tierSubscribeRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  const catalog = resolvePricingCatalogEntry(parsed.data.tier);
  if (!catalog) {
    return NextResponse.json({ error: 'invalid_tier' }, { status: 404 });
  }

  if (catalog.kind === 'contact') {
    return NextResponse.json(
      { kind: 'contact', redirect: '/contact?plan=enterprise' },
      { status: 200 },
    );
  }

  if (catalog.kind === 'free') {
    try {
      const user = await getSessionUser();
      if (!user) {
        return NextResponse.json(
          { kind: 'free', redirect: '/signup?tier=starter' },
          { status: 200 },
        );
      }
      await writeStarterSubscription(user.id);
      return NextResponse.json({ kind: 'free', redirect: '/dashboard' }, { status: 200 });
    } catch {
      return NextResponse.json({ error: 'free_write_failed' }, { status: 500 });
    }
  }

  // PRO (catalog.kind === 'stripe'). Defence in depth: anonymous Pro
  // click → route the buyer to sign in before they ever see a
  // checkout session. The success-verify side ALSO rejects anonymous
  // Pro upgrades by rejecting `requireAuth` on the write path, but
  // the page-side nudge stops the redirect and avoids a wasted
  // Stripe redirect when the buyer is already not authenticated.
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json(
      { kind: 'binding_required', redirect: '/signup?tier=pro' },
      { status: 200 },
    );
  }

  // PRO path with a signed-in user. Defensive: a priceUsd-null entry
  // would mean the catalog row was authored wrong; fail loud rather
  // than silently minting a $0 subscription session.
  if (catalog.priceUsd === null) {
    return NextResponse.json({ error: 'tier_unavailable' }, { status: 503 });
  }
  const origin = resolveRequestOriginStrict(req);
  try {
    // ────────────────────────────────────────────────────────────────────
    // IDENTITY BINDING AT CREATE-TIME
    // ────────────────────────────────────────────────────────────────────
    // `customerEmail` + `metadata: { tier:'pro', userId }` are attached so
    // the Polsia proxy's audit trail carries the user identity that paid
    // for the session. The verify-time binding check relies on
    // `user.email === verified.payment.customer_email` (case-insensitive)
    // because `verifyCheckoutSession` does NOT echo `metadata` — an audit
    // limitation documented in this file's header.
    //
    // ────────────────────────────────────────────────────────────────────
    // NO INBOUND STRIPE WEBHOOK
    // ────────────────────────────────────────────────────────────────────
    // Stripe→Polsia events arrive via `listPaymentEvents` (cursor feed)
    // ONLY. There IS no `/api/webhooks/stripe` route in this app, and one
    // must NOT be added — that's the stripe-payments SKILL + stripe-billing
    // module constraint. Webhook forging is impossible because no callback
    // endpoint exists, and the only path to elevate a row to `tier:'pro'`
    // is `verifyCheckoutSession` (success page) or `listPaymentEvents`
    // (optional cron in the future).
    const session = await createCheckoutSession({
      lineItems: [
        {
          name: catalog.productName,
          amountUsd: catalog.priceUsd,
          quantity: 1,
        },
      ],
      successUrl: `${origin}/billing/success?session_id={CHECKOUT_SESSION_ID}&tier=pro`,
      cancelUrl: `${origin}/billing/cancelled`,
      name: catalog.productName,
      description: catalog.description,
      customerEmail: user.email ?? undefined,
      metadata: { tier: 'pro', userId: user.id },
    });
    return NextResponse.json({ kind: 'stripe', url: session.url }, { status: 201 });
  } catch (err) {
    if (err instanceof StripeBillingNotEnabledError) {
      return NextResponse.json({ error: 'payments_not_enabled' }, { status: 503 });
    }
    if (err instanceof StripeBillingOnboardingError) {
      return NextResponse.json({ error: err.code }, { status: 503 });
    }
    if (err instanceof StripeBillingConfigurationError) {
      return NextResponse.json({ error: 'stripe_billing_not_configured' }, { status: 503 });
    }
    return NextResponse.json({ error: 'checkout_failed' }, { status: 502 });
  }
}
