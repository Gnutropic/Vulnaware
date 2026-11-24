// @polsia:user-owned
//
// POST /api/billing/team-subscribe
// Creates a Stripe Connect Checkout session for the $49/mo Team plan and
// returns the hosted checkout URL. The Team tier on /pricing posts here;
// the server prices the line item, the browser only relays the intent.
//
// Prices are ALWAYS server-side (stripe-billing AGENT.md) — the request only
// carries the product slug; the route resolves the amount from a single source
// of truth below. When a buyer finishes checkout they land on
// /billing/success?session_id=… where verifyCheckoutSession confirms the
// payment against Polsia's company-payment records.
//
// IDENTITY BINDING at create-time: signed-in callers get
// `customerEmail: user.email` + `metadata: { tier:'pro', userId: user.id }`
// (note this is the team-subscribe path; the metadata tier key keeps the
// success-verify catalog inference stable) so the Polsia proxy audit trail
// carries who paid. Anonymous buyers are kept on the public flow — Team
// onboarding through a single workspace + the success-verify binding check
// rejects mismatched identities.
//
// All routes in this module share:
//   - Origin / sec-fetch-site allowlist (`isBrowserNavigationOriginTrusted`)
//   - `withRateLimit` bucket around the inner handler.

import 'server-only';
import { NextResponse } from 'next/server';
import { brand } from '@/lib/brand';
import {
  isBrowserNavigationOriginTrusted,
  resolveRequestOriginStrict,
} from '@/lib/business/billing-origin';
import { teamSubscribeRequestSchema } from '@/lib/contracts/billing';
import { withRateLimit } from '@/lib/rate-limit';
import { getSessionUser } from '@/lib/require-auth';
import {
  createCheckoutSession,
  StripeBillingConfigurationError,
  StripeBillingNotEnabledError,
  StripeBillingOnboardingError,
} from '@/lib/stripe-billing/client';

// Server-side pricing — the SOLE source of truth for the Team line item.
// Change this number (and only this number) to repack the Team plan.
const TEAM_PRODUCT = {
  slug: 'team_subscription',
  name: 'Team subscription',
  description: `${brand.name} Team plan — continuous vulnerability intelligence for teams`,
  amountUsd: 49,
} as const;

export async function POST(req: Request) {
  return withRateLimit(req, async () => runTeamSubscribe(req));
}

async function runTeamSubscribe(req: Request): Promise<Response> {
  if (!isBrowserNavigationOriginTrusted(req)) {
    return NextResponse.json({ error: 'origin_not_allowed' }, { status: 403 });
  }

  const parsed = teamSubscribeRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  if (parsed.data.productId !== TEAM_PRODUCT.slug) {
    return NextResponse.json({ error: 'unknown_product' }, { status: 404 });
  }

  const origin = resolveRequestOriginStrict(req);
  const user = await getSessionUser();

  try {
    const session = await createCheckoutSession({
      lineItems: [
        {
          name: TEAM_PRODUCT.name,
          amountUsd: TEAM_PRODUCT.amountUsd,
          quantity: 1,
        },
      ],
      successUrl: `${origin}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/billing/cancelled`,
      name: TEAM_PRODUCT.name,
      description: TEAM_PRODUCT.description,
      // Attach identity binding when the buyer is signed in — `customerEmail`
      // is the proxy's customer_email echo; `metadata.userId` is the
      // forward-compatible audit trail for a future `listPaymentEvents`-
      // driven re-derivation. Anonymous buyers skip these fields and the
      // success-verify binding check will still gate the Pro write.
      ...(user?.email ? { customerEmail: user.email } : {}),
      ...(user?.id ? { metadata: { tier: 'pro', userId: user.id } } : {}),
    });
    return NextResponse.json({ url: session.url }, { status: 201 });
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
