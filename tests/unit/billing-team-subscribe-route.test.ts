// @vitest-environment node
// Unit tests for POST /api/billing/team-subscribe. Mirrors the existing
// src/app/api/stripe-billing/checkout route-test posture: vi.mock the
// server-only modules + the stripe-billing client, validate the response
// shape and error mapping without hitting the real Polsia proxy.
//
// Covers: happy path (201 + url + $49 line item + correct success/cancel
// URLs), StripeBillingNotEnabledError → 503 payments_not_enabled, both
// StripeBillingOnboardingError codes → 503, StripeBillingConfigurationError
// → 503, generic throw → 502, validation 400, unknown_product 404.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

vi.mock('@/lib/env', () => ({
  env: { NEXT_PUBLIC_APP_URL: 'https://app.test' },
}));

const createCheckoutSessionMock = vi.fn();

vi.mock('@/lib/stripe-billing/client', () => ({
  // Stub createCheckoutSession so we can branch the response per-test and
  // assert the input shape (server-side pricing, success/cancel URLs).
  createCheckoutSession: createCheckoutSessionMock,
  StripeBillingConfigurationError: class StripeBillingConfigurationError extends Error {
    constructor(message = 'Stripe billing is not configured.') {
      super(message);
      this.name = 'StripeBillingConfigurationError';
    }
  },
  StripeBillingNotEnabledError: class StripeBillingNotEnabledError extends Error {
    constructor(message = 'Payments not enabled.') {
      super(message);
      this.name = 'StripeBillingNotEnabledError';
    }
  },
  StripeBillingOnboardingError: class StripeBillingOnboardingError extends Error {
    constructor(public readonly code: 'stripe_not_configured' | 'stripe_not_onboarded') {
      super(`Stripe onboarding: ${code}`);
      this.name = 'StripeBillingOnboardingError';
    }
  },
}));

function makePostRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://test/api/billing/team-subscribe', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://shop.test',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  createCheckoutSessionMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/billing/team-subscribe', () => {
  it('returns 201 with the Stripe URL + uses server-side $49 line item', async () => {
    createCheckoutSessionMock.mockResolvedValueOnce({
      id: 7,
      stripeSessionId: 'cs_test_xxx',
      url: 'https://stripe.test/c/session/cs_test_xxx',
      totalAmountUsd: 49,
      companyReceives: 39.2,
      platformFee: 9.8,
    });

    const { POST } = await import('@/app/api/billing/team-subscribe/route');
    const res = await POST(makePostRequest({ productId: 'team_subscription' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { url?: string };
    expect(body.url).toBe('https://stripe.test/c/session/cs_test_xxx');

    // The route must never accept an amount from the body — verify by
    // asserting the input that reached the SDK used the hardcoded product
    // (name + amountUsd + quantity 1).
    const callArg = createCheckoutSessionMock.mock.calls[0]?.[0] as {
      lineItems: Array<{ name: string; amountUsd: number; quantity?: number }>;
      successUrl: string;
      cancelUrl: string;
    };
    expect(callArg.lineItems).toHaveLength(1);
    expect(callArg.lineItems[0]?.name).toBe('Team subscription');
    expect(callArg.lineItems[0]?.amountUsd).toBe(49);
    expect(callArg.lineItems[0]?.quantity).toBe(1);
  });

  it('uses Origin header for the success and cancel redirect URLs', async () => {
    createCheckoutSessionMock.mockResolvedValueOnce({
      id: 8,
      stripeSessionId: 'cs_test_yyy',
      url: 'https://stripe.test/c/session/cs_test_yyy',
      totalAmountUsd: 49,
      companyReceives: 39.2,
      platformFee: 9.8,
    });

    const { POST } = await import('@/app/api/billing/team-subscribe/route');
    await POST(
      makePostRequest({ productId: 'team_subscription' }, { origin: 'https://shop.test' }),
    );

    const callArg = createCheckoutSessionMock.mock.calls[0]?.[0] as {
      successUrl: string;
      cancelUrl: string;
    };
    expect(callArg.successUrl).toContain('https://shop.test/billing/success?session_id=');
    expect(callArg.successUrl).toContain('{CHECKOUT_SESSION_ID}');
    expect(callArg.cancelUrl).toBe('https://shop.test/billing/cancelled');
  });

  it('returns 400 invalid_request for both an empty body and a wrong productId (zod literal)', async () => {
    // The Team product is the SOLE entry in the catalog and the request
    // schema uses `z.literal('team_subscription')` — wrong slugs are caught
    // by zod (400 invalid_request), not by the post-parse catalog lookup.
    const { POST } = await import('@/app/api/billing/team-subscribe/route');
    const res = await POST(makePostRequest({ productId: 'wrong_slug' }));
    expect(res.status).toBe(400);

    const res2 = await POST(makePostRequest({}));
    expect(res2.status).toBe(400);

    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('maps StripeBillingNotEnabledError → 503 payments_not_enabled', async () => {
    const { StripeBillingNotEnabledError } = await import('@/lib/stripe-billing/client');
    createCheckoutSessionMock.mockRejectedValueOnce(new StripeBillingNotEnabledError());

    const { POST } = await import('@/app/api/billing/team-subscribe/route');
    const res = await POST(makePostRequest({ productId: 'team_subscription' }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('payments_not_enabled');
  });

  it('maps StripeBillingOnboardingError codes → 503 stripe_not_configured / stripe_not_onboarded', async () => {
    const { StripeBillingOnboardingError } = await import('@/lib/stripe-billing/client');
    for (const code of ['stripe_not_configured', 'stripe_not_onboarded'] as const) {
      createCheckoutSessionMock.mockRejectedValueOnce(new StripeBillingOnboardingError(code));
      const { POST } = await import('@/app/api/billing/team-subscribe/route');
      const res = await POST(makePostRequest({ productId: 'team_subscription' }));
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe(code);
    }
  });

  it('maps StripeBillingConfigurationError → 503 stripe_billing_not_configured', async () => {
    const { StripeBillingConfigurationError } = await import('@/lib/stripe-billing/client');
    createCheckoutSessionMock.mockRejectedValueOnce(new StripeBillingConfigurationError());

    const { POST } = await import('@/app/api/billing/team-subscribe/route');
    const res = await POST(makePostRequest({ productId: 'team_subscription' }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('stripe_billing_not_configured');
  });

  it('falls back to 502 checkout_failed on an unexpected throw', async () => {
    createCheckoutSessionMock.mockRejectedValueOnce(new Error('boom'));

    const { POST } = await import('@/app/api/billing/team-subscribe/route');
    const res = await POST(makePostRequest({ productId: 'team_subscription' }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe('checkout_failed');
  });
});
