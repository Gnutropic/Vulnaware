// @polsia:user-owned — zod contract for the trial-funnel analytics surface.
//
// Pure zod, no server-only side effects — shared between the POST/GET
// route handlers and the client tracker islands. Used by:
//   - POST /api/analytics/events body / response
//   - GET  /api/analytics/trail response
//   - src/components/custom/trial/{signup,dashboard}-view-tracker.tsx
//   - src/components/custom/trial/cloud-connection-nudge.tsx (this surface's
//     new nudge island)
//   - src/lib/business/analytics.ts (server-side logger; pure-data shape)
//
// The contract is intentionally split into its own file so a route that
// only needs to `apiFetch('/api/analytics/trial', { schema })` does not
// drag in the broader trial schemas.

import { z } from 'zod';

// Funnel step discriminator. Order is the canonical onboarding sequence:
// page load → workspace created → first scan → dashboard viewed.
// `cloud_nudge_shown` and `cloud_nudge_clicked` are A/B-instrumented
// interactions emitted by CloudConnectionNudge; they sit alongside the
// baseline steps so admin reads can measure nudge lift over the
// dashboard_viewed step.
export const TrialFunnelStep = z.enum([
  'signup_page_view',
  'trial_workspace_created',
  'first_scan_triggered',
  'dashboard_viewed',
  'cloud_nudge_shown',
  'cloud_nudge_clicked',
]);

// POST /api/analytics/events body.
//   - step 1 is anonymous: the client supplies its cookie-derived
//     `anonymousId` (mirrors the PolsiaAnalytics visitor beacon).
//   - steps 2-4 are server-resolved from the session; the route ignores
//     any `anonymousId` field on authed writes. Keeping the field
//     optional keeps the schema parseable for both shapes.
//   - `cohort` + `experiment` label the write for A/B segmentation. The
//     server doesn't resolve them from session — the client island
//     assigns cohort (sticky via localStorage) and the server trusts it
//     for non-step-1 writes. Step 1 ignores any cohort/experiment
//     fields the client sends (anonymous visitors aren't cohort-bound).
export const TrialFunnelEventIngest = z.object({
  step: TrialFunnelStep,
  anonymousId: z.string().min(1).max(64).optional(),
  cohort: z.string().min(1).max(64).optional(),
  experiment: z.string().min(1).max(64).optional(),
});

// POST /api/analytics/events response. Always 200 with `{ ok: true }` for
// accepted writes; 4xx field errors carry `{ errors: { _: '...' } }`.
// Fire-and-forget writes succeed even when the underlying insert throws
// (analytics must never break the UX), so this surface stays simple.
export const TrialFunnelEventIngestResponse = z.object({
  ok: z.literal(true),
});

// Edge in the funnel graph. `rate = completed / entered` over the
// per-team scope, normalised to 0 when `entered === 0` so the front end
// can render a single `--` placeholder without dividing by zero.
export const TrialFunnelRate = z.object({
  from: TrialFunnelStep,
  to: TrialFunnelStep,
  entered: z.number().int().min(0),
  completed: z.number().int().min(0),
  rate: z.number().min(0).max(1),
});

// Query filter for the admin segmented read. All fields optional. The
// `windowStart` / `windowEnd` pair narrows by `createdAt`. The route
// ignores this entire surface unless one of the fields is set AND the
// caller passes an admin session.
export const TrialAnalyticsCohortFilter = z.object({
  cohort: z.string().min(1).max(64).optional(),
  experiment: z.string().min(1).max(64).optional(),
  windowStart: z.string().datetime().optional(),
  windowEnd: z.string().datetime().optional(),
});

// GET /api/analytics/trial response. `partial` carries the three
// inter-step rates in a flat shape so a dashboard can render a single
// funnel without re-deriving the pairs client-side. Counts always
// include every step (zero-fill if a step has no events yet) so the
// front end never has to guard against `undefined`.
export const TrialAnalyticsResponse = z.object({
  windowStart: z.string(),
  counts: z.record(TrialFunnelStep, z.number().int().min(0)),
  rates: z.array(TrialFunnelRate),
  partial: z.object({
    step1To2: z.number().min(0).max(1),
    step2To3: z.number().min(0).max(1),
    step3To4: z.number().min(0).max(1),
  }),
});

export type TrialFunnelStep = z.infer<typeof TrialFunnelStep>;
export type TrialFunnelEventIngest = z.infer<typeof TrialFunnelEventIngest>;
export type TrialFunnelEventIngestInput = z.input<typeof TrialFunnelEventIngest>;
export type TrialFunnelEventIngestResponse = z.infer<typeof TrialFunnelEventIngestResponse>;
export type TrialFunnelRate = z.infer<typeof TrialFunnelRate>;
export type TrialAnalyticsCohortFilter = z.infer<typeof TrialAnalyticsCohortFilter>;
export type TrialAnalyticsResponse = z.infer<typeof TrialAnalyticsResponse>;
export type TrialAnalyticsResponseInput = z.input<typeof TrialAnalyticsResponse>;
