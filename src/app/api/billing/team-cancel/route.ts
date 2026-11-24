// @polsia:user-owned
//
// POST /api/billing/team-cancel
// Opens the Stripe-hosted billing portal for the signed-in user. The portal
// is where subscription state is actually changed (per stripe-payments SKILL
// §"Subscriptions": do NOT build an inbound cancel/callback route — the
// Stripe-hosted portal IS the cancel UI). On success the route returns
// `{ url }`; the island full-page navigates there and Stripe returns the
// user to /billing/cancelled.
//
// AUTH-GATED on purpose: only the calling user can request a portal session
// for their own email. Mirrors the per-user gate pattern at
// src/app/api/example-secure/route.ts (Risk 3 — fetch MUST be server-side
// and ONLY for the calling user).

import 'server-only';
import { NextResponse } from 'next/server';
import { teamCancelRequestSchema } from '@/lib/contracts/billing';
import { env } from '@/lib/env';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import {
  StripeBillingConfigurationError,
  StripeBillingNotEnabledError,
  StripeBillingOnboardingError,
} from '@/lib/stripe-billing/client';

export const dynamic = 'force-dynamic';

// Duplicate of the origin resolver on /api/billing/team-subscribe — see
// that file for why `new URL(req.url).origin` is wrong behind Polsia's
// proxy. A shared helper would be a fine follow-up but is out of scope.
function resolveOrigin(req: Request): string {
  const fromOrigin = req.headers.get('origin');
  if (fromOrigin) return fromOrigin.replace(/\/+$/, '');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (host) {
    const proto = req.headers.get('x-forwarded-proto') ?? 'https';
    return `${proto}://${host}`;
  }
  return env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');
}

// Stripe-billing exposes its proxy endpoints at ${POLSIA_API_BASE_URL}
// /api/company-payments/* (per stripe-payments SKILL §"Routing"). The
// billing-portal path is the documented convention for the Stripe-hosted
// portal endpoint; if Polsia has not yet shipped this surface the proxy
// returns 404 and the route degrades to `portal_unavailable` rather than
// 500ing — the island shows a friendly message in that case.
const PORTAL_PATH = '/api/company-payments/billing-portal';

async function proxyPortalSession(input: { email: string; returnUrl: string }): Promise<string> {
  const apiKey = env.POLSIA_API_KEY ?? env.POLSIA_API_TOKEN;
  if (!apiKey) {
    throw new StripeBillingConfigurationError();
  }
  const baseUrl = env.POLSIA_API_BASE_URL.replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}${PORTAL_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email: input.email, return_url: input.returnUrl }),
    cache: 'no-store',
  });
  const body = (await res.json().catch(() => null)) as { url?: unknown; error?: unknown } | null;
  if (res.ok) {
    const url = typeof body?.url === 'string' ? body.url : null;
    if (!url) {
      throw new Error('billing portal response missing url');
    }
    return url;
  }
  const detail = typeof body?.error === 'string' ? body.error : '';
  if (res.status === 404 && detail === 'not_enabled') {
    throw new StripeBillingNotEnabledError();
  }
  if (
    res.status === 409 &&
    (detail === 'stripe_not_configured' || detail === 'stripe_not_onboarded')
  ) {
    throw new StripeBillingOnboardingError(detail);
  }
  if (res.status === 404 || res.status === 409) {
    // Proxy reached but doesn't expose a billing-portal surface yet. Surface
    // as a typed `portal_unavailable` so the island can render a friendly
    // message instead of a Stripe exception.
    const probe = new Error('portal_unavailable');
    (probe as Error & { code?: string }).code = 'portal_unavailable';
    throw probe;
  }
  throw new Error(`Polsia billing API request failed: ${res.status} ${detail}`.trim());
}

export async function POST(req: Request) {
  let user: SessionUser;
  try {
    user = await requireAuth(req);
  } catch (res) {
    return res as Response;
  }

  // The contract validates an EMPTY body: auth gates the user, the route
  // resolves the email from the session, and the client doesn't get to pick
  // whose portal is opened.
  const parsed = teamCancelRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  if (!user.email) {
    return NextResponse.json({ error: 'email_required' }, { status: 400 });
  }

  const origin = resolveOrigin(req);
  try {
    const url = await proxyPortalSession({
      email: user.email,
      returnUrl: `${origin}/billing/cancelled`,
    });
    return NextResponse.json({ url }, { status: 200 });
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
    const code = (err as Error & { code?: string }).code;
    if (code === 'portal_unavailable') {
      return NextResponse.json({ error: 'portal_unavailable' }, { status: 503 });
    }
    return NextResponse.json({ error: 'portal_failed' }, { status: 502 });
  }
}
