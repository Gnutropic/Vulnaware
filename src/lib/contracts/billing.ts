// @polsia:user-owned — billing client/server contract.
//
// Imports are zod-only (no server-only modules) so the same file is safe for
// `'use client'` islands and the API route handler to import. Single source of
// truth for request and response shapes — drift between the client button and
// the route handler surfaces here as a `tsc` / runtime `ZodError`, not a silent
// shape mismatch.

import { z } from 'zod';
import {
  checkoutVerificationResultSchema,
  subscriptionStatusResultSchema,
  verifiedPaymentSchema,
} from '@/lib/stripe-billing/schema';

// Stripe Checkout session ids look like `cs_test_a1B2c3...` / `cs_live_…`.
// Tightened from `min(1)` to this regex so a junk / SQL-ish payload can't
// reach the proxy. Anonymous buys from /pricing never produce a session id
// the buyer sees — only Stripe-signed ones get there.
export const stripeSessionIdRegex = /^cs_(test|live)_[A-Za-z0-9]+$/;

export const teamSubscribeRequestSchema = z.object({
  productId: z.literal('team_subscription'),
});

export const teamSubscribeResponseSchema = z.object({
  url: z.string().url(),
});

/**
 * POST /api/billing/tier-subscribe — per-tier button mounted on
 * /pricing. The server resolves the amount from its catalog so the
 * browser only relays the intent. Four response variants:
 *   - 'stripe'            → `{ url }` (full-page nav to hosted Checkout)
 *   - 'free'              → `{ redirect }` (Starter upsert was written, navigate in-app)
 *   - 'contact'           → `{ redirect }` (Enterprise → /contact?plan=enterprise)
 *   - 'binding_required'  → Pro picked but the caller isn't signed in;
 *                          `{ redirect }` deep-links them to /signup?tier=pro
 *                          so they sign in BEFORE the Stripe redirect.
 *                          This closes the anonymous-Pro edge at the page,
 *                          not the success page.
 */
export const tierSubscribeRequestSchema = z.object({
  tier: z.enum(['starter', 'pro', 'enterprise']),
});

export const tierSubscribeResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('stripe'),
    // Absolute URL — full-page nav to hosted Checkout.
    url: z.string().url(),
  }),
  z.object({
    kind: z.literal('free'),
    // In-app path (e.g. '/dashboard') OR absolute URL — the island uses
    // `router.push` for both. `min(1)` over `.url()` so an in-app path
    // round-trips through zod without coercing to an absolute.
    redirect: z.string().min(1),
  }),
  z.object({
    kind: z.literal('contact'),
    redirect: z.string().min(1),
  }),
  z.object({
    kind: z.literal('binding_required'),
    redirect: z.string().min(1),
  }),
]);

/**
 * POST /api/billing/success-verify — the success page POSTs the
 * sessionId (and the `?tier=` URL param, when present) to write the
 * UserSubscription row. The response carries:
 *   - `verified`  — the proxy's verified/{verified:false} result (ORIGINAL
 *                   TIGHTENING: never echo `plan:'pro'` when verified is
 *                   false; the poller island treats the response as a
 *                   non-success so the buyer doesn't see a fake success card)
 *   - `binding`   — discriminator telling the island what to render:
 *                     'verified_and_bound'  → success card + router.refresh()
 *                     'verified_not_bound'  → "this session wasn't paid by
 *                                             the signed-in account" retry
 *                     'verification_failed' → fall through to the poller
 *   - `binding_reason`  — when binding !== 'verified_and_bound', the reason
 *                         ('anonymous_buyer', 'email_mismatch', 'none')
 *   - `plan`      —echoed ONLY when verified === true AND binding ===
 *                   'verified_and_bound'; any other branch puts plan =
 *                   'unknown' so a stray success-card render never lies.
 *   - `payment`   — the verified payment shape, present only on
 *                   verified_and_bound (PII redaction beyond this point is
 *                   the responsibility of the route handler).
 *   - `error`     — typed Stripe-billing error code on the failure branches.
 */
export const successVerifyRequestSchema = z.object({
  sessionId: z.string().regex(stripeSessionIdRegex, 'invalid session id'),
  tier: z.enum(['starter', 'pro', 'enterprise']).optional(),
});

export const successVerifyBindingSchema = z.enum([
  'verified_and_bound',
  'verified_not_bound',
  'verification_failed',
]);

export const successVerifyBindingReasonSchema = z.enum([
  'email_mismatch',
  'metadata_user_mismatch',
  'none',
]);

export const successVerifyResponseSchema = z.object({
  verified: z.boolean(),
  binding: successVerifyBindingSchema,
  binding_reason: successVerifyBindingReasonSchema,
  plan: z.enum(['starter', 'pro', 'enterprise', 'unknown']),
  payment: verifiedPaymentSchema.optional(),
  error: z.string().optional(),
});

/**
 * POST /api/billing/verify — auth-gated redacted verify the
 * BillingVerificationPoller uses after the synchronous success-verify
 * returns 'verification_failed'. Route asserts
 * `user.email === verified.payment.customer_email` server-side and
 * returns a shape with `customer_email` stripped so a scraper can't
 * enumerate who paid what through this endpoint.
 *   request:  `{ sessionId }`
 *   response: `{ verified, binding, binding_reason?, plan, product_name?, amount_usd?, error? }`
 */
export const billingVerifyRequestSchema = z.object({
  sessionId: z.string().regex(stripeSessionIdRegex, 'invalid session id'),
});

export const billingVerifyResponseSchema = z.object({
  verified: z.boolean(),
  binding: successVerifyBindingSchema,
  binding_reason: successVerifyBindingReasonSchema.optional(),
  plan: z.enum(['starter', 'pro', 'enterprise', 'unknown']),
  product_name: z.string().nullable().optional(),
  amount_usd: z.number().nullable().optional(),
  error: z.string().optional(),
});

/**
 * GET /api/account/active-plan — the per-user active plan seam used
 * by /account. `source: 'local'` means the user's row in
 * `UserSubscription` is the truth; `source: 'proxy'` means we fell
 * through to `getSubscriptionStatus` because the local row was
 * absent or inactive.
 */
export const activePlanResponseSchema = z.object({
  plan: z.enum(['starter', 'pro', 'enterprise', 'unknown']),
  source: z.enum(['local', 'proxy']),
  status: subscriptionStatusResultSchema.optional(),
});

/**
 * POST /api/billing/team-cancel — open the Stripe-hosted billing portal so the
 * user can manage/cancel from there. The caller is auth-gated server-side via
 * requireAuth, so the request body is intentionally empty: the route resolves
 * the user from the session and relays `{ email, return_url }` to the proxy.
 */
export const teamCancelRequestSchema = z.object({});

export const teamCancelResponseSchema = z.object({
  url: z.string().url(),
});

export type TeamSubscribeRequest = z.infer<typeof teamSubscribeRequestSchema>;
export type TeamSubscribeResponse = z.infer<typeof teamSubscribeResponseSchema>;
export type TierSubscribeRequest = z.infer<typeof tierSubscribeRequestSchema>;
export type TierSubscribeResponse = z.infer<typeof tierSubscribeResponseSchema>;
export type SuccessVerifyRequest = z.infer<typeof successVerifyRequestSchema>;
export type SuccessVerifyResponse = z.infer<typeof successVerifyResponseSchema>;
export type Binding = z.infer<typeof successVerifyBindingSchema>;
export type BindingReason = z.infer<typeof successVerifyBindingReasonSchema>;
export type BillingVerifyRequest = z.infer<typeof billingVerifyRequestSchema>;
export type BillingVerifyResponse = z.infer<typeof billingVerifyResponseSchema>;
export type ActivePlanResponse = z.infer<typeof activePlanResponseSchema>;
export type TeamCancelRequest = z.infer<typeof teamCancelRequestSchema>;
export type TeamCancelResponse = z.infer<typeof teamCancelResponseSchema>;

export { checkoutVerificationResultSchema, verifiedPaymentSchema, subscriptionStatusResultSchema };
