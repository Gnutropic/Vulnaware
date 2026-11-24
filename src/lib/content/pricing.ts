// @polsia:user-owned — typed seed for the public /pricing page tier grid.
//
// Mirrors the src/lib/content/changelog.ts precedent: typed `as const`,
// hand-authored for stability across builds, no DB / server-only imports.
// Future edits to prices, feature lists, or CTAs are a single-file change
// here; the page itself is markup + composition only.
//
// `slug` MUST stay byte-for-byte aligned with `TieredTrialSignupTier` in
// src/lib/contracts/trial.ts:44 so a `/signup?tier=<slug>&trial=1` deep-link
// from this page round-trips through the tier-aware signup branch without a
// conversion step. The matching `name` (the user-facing display label) is
// intentionally separate: the brief names the tiers Starter / Team / Pro
// while the signup contract uses slugs starter / pro / enterprise.
//
// `ctaHref` ALWAYS carries the slug, not the name — `/signup?tier=team` would
// fail `safeParse` on `TieredTrialSignupTier` and silently fall back to
// `starter`, landing the visitor on the wrong plan.

export type PricingTierSlug = 'starter' | 'pro' | 'enterprise';

export interface PricingTier {
  /** Signup-contract slug — must match `TieredTrialSignupTier` exactly. */
  slug: PricingTierSlug;
  /** Display label shown on the card (brief: Starter / Team / Pro). */
  name: string;
  /** Price string shown large on the card, e.g. "$0", "$49", "Custom". */
  monthlyPriceLabel: string;
  /** Optional small caption under the price. */
  priceSubLabel?: string;
  /** One-sentence positioning line shown under the tier name. */
  tagline: string;
  /** Highlights the middle card and pins the "Most popular" badge. */
  highlighted?: boolean;
  /** Feature bullets, rendered top-to-bottom with a check icon. */
  features: readonly string[];
  /** CTA button label. */
  ctaLabel: string;
  /** Deep-link to /signup carrying the slug + trial=1. */
  ctaHref: string;
}

export const pricingTiers: readonly PricingTier[] = [
  {
    slug: 'starter',
    name: 'Starter',
    monthlyPriceLabel: '$0',
    priceSubLabel: 'Up to 100 scans / month',
    tagline: 'For solo developers getting a handle on their own attack surface.',
    features: [
      'Up to 3 seats included',
      'Continuous external-surface monitoring on 1 domain',
      'Asset inventory + certificate tracking',
      'CVE-feed watch with weekly digest',
      'Public SaaS posture check (read-only)',
      'Slack & email alerting on new Criticals',
      'Community remediation playbooks',
    ],
    ctaLabel: 'Start free trial',
    ctaHref: '/signup?tier=starter&trial=1',
  },
  {
    slug: 'pro',
    name: 'Team',
    monthlyPriceLabel: '$49',
    priceSubLabel: 'Per workspace / month',
    tagline: 'Most teams pick Team — full coverage with prioritized remediation.',
    highlighted: true,
    features: [
      'Up to 25 seats included',
      'Everything in Starter, plus:',
      'Unlimited domains + subdomains across external surface',
      'Authenticated internal scanning at protocol depth',
      'Cloud posture review across AWS, Azure, GCP',
      'DAST + targeted dynamic testing for live services',
      'SCA + SBOM tracking against the dependency graph',
      'Exploitability scoring ranked by your real environment',
      'Jira · Linear · Slack · PagerDuty routing',
      'SOC 2 / ISO 27001 / HIPAA / PCI evidence export',
    ],
    ctaLabel: 'Start free trial',
    ctaHref: '/signup?tier=pro&trial=1',
  },
  {
    slug: 'enterprise',
    name: 'Pro',
    monthlyPriceLabel: 'Custom',
    priceSubLabel: 'Annual contract, scaled to your surface',
    tagline: 'Self-hosted or single-tenant managed — built for regulated teams.',
    features: [
      'Unlimited seats',
      'Everything in Team, plus:',
      'Self-hosted control plane in your cloud or on-prem',
      'SSO / SCIM, SAML, OIDC, audit-log streaming',
      'Dedicated VPC peering + private-link scanning',
      '99.9% uptime SLA with 24×7 named-response support',
      'Custom rule authoring + threat-intel feed ingestion',
      'Named technical account manager + onboarding squad',
      'MSA, DPA, SOC 2 Type II report on request',
    ],
    ctaLabel: 'Start free trial',
    ctaHref: '/signup?tier=enterprise&trial=1',
  },
];
