// @polsia:user-owned — zod contract for the public self-serve trial flow.
// Mirrors src/lib/contracts/example.ts style: pure zod, no server-only imports,
// so client islands can import the same shapes via apiFetch's schema option.
// Single source of truth shared between /api/v1/trial-signup,
// /api/trial-status, and the TrialCta / TrialExpiryBanner / OnboardingStepper
// islands.

import { z } from 'zod';

// Self-reported company size buckets — surfaced on the trial signup form.
// Captured best-effort; the contract and the TrialWorkspace.companySize
// column treat it as optional so the landing remains graceful if the
// visitor skips it.
export const CompanySize = z.enum(['1-10', '11-50', '51-200', '201-1000', '1000+']);
export type CompanySize = z.infer<typeof CompanySize>;

// POST /api/v1/trial-signup body — conversion surface (intentionally
// unauthenticated). `confirmEmail` is a honeypot: a real user never fills
// it, but a bot will. The server rejects non-empty values silently by
// returning the same OK shape with no work performed.
export const TrialSignupBody = z.object({
  email: z.string().email().max(254),
  company: z.string().min(1).max(120),
  workspaceName: z.string().min(2).max(80).optional(),
  // Company-size bucket — surfaced by the trial signup form so growth
  // analytics can segment inbound trials. Optional on the boundary; the
  // TrialWorkspace column mirrors that.
  companySize: CompanySize.optional(),
  // Honeypot — real users never fill it; bots do. We accept any string so
  // the field is parseable, but the server treats a non-empty value as a
  // silent no-op success (200 with the success envelope + no work).
  confirmEmail: z.string().max(120).optional(),
});

export const TrialClaimBody = z.object({
  token: z.string().min(20).max(200),
});

// Tier pre-selection enum for the public tier-aware signup. Mirrors
// `PricingTierSlug` in `@/lib/pricing-tiers` byte-for-byte so a
// `/signup?tier=pro` deep-link from /pricing round-trips through
// without a conversion step. Unknown values are narrowed server-side
// to the safe `starter` fallback before the orchestrator runs.
export const TieredTrialSignupTier = z.enum(['starter', 'pro', 'enterprise']);
export type TieredTrialSignupTier = z.infer<typeof TieredTrialSignupTier>;

// POST /api/trial/tiered-signup body. Visitor supplies their own
// password (no random-password + claim-link roundtrip like the legacy
// `TrialSignupBody` flow). `confirmEmail` is the same honeypot — a
// non-empty value short-circuits to OK with no work.
export const TieredTrialSignupBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
  workspaceName: z.string().min(2).max(80),
  tier: TieredTrialSignupTier,
  confirmEmail: z.string().max(120).optional(),
});

// POST /api/v1/trial-signup response. `redirectUrl` is the same-origin path
// the browser should navigate to after a successful signup (typically
// `/trial/started`). The server picks it so a future change (e.g. routing to
// /onboarding/{step}) is centrally controlled.
export const TrialCreateResponse = z.object({
  ok: z.literal(true),
  redirectUrl: z.string(),
});

// GET /api/trial-status response. `active` is true while a TrialWorkspace row
// exists for the caller's team; `daysRemaining` is a derived integer count
// (null when not active). onboardingCompleted mirrors
// TrialWorkspace.onboardingCompletedAt.
export const TrialStatus = z.object({
  active: z.boolean(),
  trialEndsAt: z.string().nullable(),
  daysRemaining: z.number().int().nullable(),
  onboardingStep: z.number().int(),
  onboardingCompleted: z.boolean(),
});

// Aggregated onboarding-step counters for the OnboardingStepper island.
// One read so the island doesn't fan out four separate /api calls. Resolved
// server-side from the caller's team.
export const trialProgressResponse = z.object({
  scansCreated: z.number().int().min(0),
  apiKeysIssued: z.number().int().min(0),
  cloudConnectionsConnected: z.number().int().min(0),
  teammatesInvited: z.number().int().min(0),
});

// Onboarding checklist card — pinned to /dashboard, surfaces the same
// trial activation steps the welcome surface shows, but as a returning-
// trial card with a dismiss option. Step `complete` flags are derived
// server-side from Scan / Invite / VulnerabilityFinding rows combined
// with existing TrialFunnelEvent writes; no new schema beyond the
// singular `onboardingChecklistDismissedAt` stamp on TrialWorkspace.
export const OnboardingStepKey = z.enum([
  'connect_first_asset',
  'run_first_scan',
  'review_findings',
  'invite_teammate',
]);

export const OnboardingStep = z.object({
  key: OnboardingStepKey,
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(280),
  ctaHref: z.string().min(1).max(2000),
  ctaLabel: z.string().min(1).max(60),
  complete: z.boolean(),
});

// GET /api/onboarding-checklist response. `completed` is the AND of all
// four step.complete flags — auto-hides the card once everything is done.
// `dismissed` mirrors TrialWorkspace.onboardingChecklistDismissedAt != null
// so the island can hide the card after a user explicitly dismisses it.
export const OnboardingChecklistResponse = z.object({
  steps: z.array(OnboardingStep).length(4),
  completed: z.boolean(),
  dismissed: z.boolean(),
});

// POST /api/onboarding-checklist response. The handler returns the
// ISO-8601 stamp so the island can show a brief post-dismiss cue
// without re-fetching.
export const OnboardingDismissResponse = z.object({
  ok: z.literal(true),
  dismissedAt: z.string(),
});

export type TrialSignupBody = z.infer<typeof TrialSignupBody>;
export type TrialSignupBodyInput = z.input<typeof TrialSignupBody>;
export type TrialClaimBody = z.infer<typeof TrialClaimBody>;
export type TieredTrialSignupBody = z.infer<typeof TieredTrialSignupBody>;
export type TieredTrialSignupBodyInput = z.input<typeof TieredTrialSignupBody>;
export type TrialCreateResponse = z.infer<typeof TrialCreateResponse>;
export type TrialStatus = z.infer<typeof TrialStatus>;
export type TrialProgressResponse = z.infer<typeof trialProgressResponse>;
export type OnboardingStepKey = z.infer<typeof OnboardingStepKey>;
export type OnboardingStep = z.infer<typeof OnboardingStep>;
export type OnboardingChecklistResponse = z.infer<typeof OnboardingChecklistResponse>;
export type OnboardingDismissResponse = z.infer<typeof OnboardingDismissResponse>;
