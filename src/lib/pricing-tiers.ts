// @polsia:user-owned — shared pricing copy. Imported by /pricing so marketing
// copy lives outside the React tree and the page stays a flat Server Component.
//
// Two exports drive the wiring:
//
//   * `pricingTiers` (const, federated to the page + client islands) — the
//     marketing copy (name, tagline, features, CTA label). Untouched this turn.
//
//   * `serverCatalog` (const) — the server-only line-item/redirect catalog
//     the /api routes resolve. The page DOES NOT import this; the
//     route handler + the `resolvePricingCatalogEntry` helper in
//     src/lib/business/pricing.ts do. Keeping the file user-owned
//     means JSON-LD price lookups can still live next to the marketing
//     copy (single-file source-of-truth) without breaking the
//     data-plane rule that pages do not import server-only modules —
//     this file imports nothing server-only.

import { brand } from '@/lib/brand';

export type PricingTierSlug = 'starter' | 'pro' | 'enterprise';
export type SubscribeProductId = 'team_subscription';

export interface PricingTier {
  slug: PricingTierSlug;
  name: string;
  priceLabel: string;
  priceSubLabel?: string;
  tagline: string;
  highlighted?: boolean;
  features: readonly string[];
  ctaLabel: string;
  // When set, the tier CTA is rendered by the TeamSubscribeButton island
  // (POSTs to /api/billing/team-subscribe → hosted Stripe Checkout). The tier
  // entry MUST NOT also carry ctaHref — the runtime checkout replaces it.
  subscribeProductId?: SubscribeProductId;
  // Stripe Checkout URL — when set, the tier's CTA opens this absolute URL
  // (Stripe-hosted Checkout) in a new tab via `<a target="_blank" rel>`. When
  // absent, the grid falls back to the trial deep-link below. Set this only
  // after `create_payment_link` (Stripe MCP) returns a real reusable URL —
  // never a placeholder, TODO, or hand-typed buy.stripe.com string.
  stripeUrl?: string;
  // Override for the grid CTA destination when there is no Stripe link.
  // The page renders this value into `<Link href={...}>`, which accepts
  // either an in-app path (e.g. '/contact') or an absolute URL. The Pro
  // tier uses this to route visitors to the contact form instead of the
  // trial endpoint.
  ctaHref?: string;
}

export const pricingTiers: readonly PricingTier[] = [
  {
    slug: 'starter',
    name: 'Starter',
    priceLabel: '$0',
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
    ctaLabel: 'Sign up free',
    ctaHref: '/signup',
  },
  {
    slug: 'pro',
    name: 'Team',
    priceLabel: '$49',
    priceSubLabel: 'Per workspace / month, billed annually',
    tagline: 'Most teams pick Pro — full coverage with prioritized remediation.',
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
    ctaLabel: 'Subscribe',
    subscribeProductId: 'team_subscription',
  },
  {
    slug: 'enterprise',
    name: 'Pro',
    priceLabel: 'Custom',
    priceSubLabel: 'Annual contract, scaled to your surface',
    tagline: 'Self-hosted or single-tenant managed — built for regulated teams.',
    features: [
      'Unlimited seats',
      'Everything in Pro, plus:',
      'Self-hosted control plane in your cloud or on-prem',
      'SSO / SCIM, SAML, OIDC, audit-log streaming',
      'Dedicated VPC peering + private-link scanning',
      '99.9% uptime SLA with 24×7 named-response support',
      'Custom rule authoring + threat-intel feed ingestion',
      'Named technical account manager + onboarding squad',
      'MSA, DPA, SOC 2 Type II report on request',
    ],
    ctaLabel: 'Contact sales',
    ctaHref: '/contact',
  },
];

// Server-side line-item/redirect catalog. Imports zod-only (no DB / no
// server-only) so the file can be read from the route handler in
// src/app/api/billing/tier-subscribe AND from the typed accessor in
// src/lib/business/pricing.ts. JSON-LD price lookups (the /pricing
// page reads them at build) reference this same map so a price edit
// is one row, not three.
export type ServerCatalogKind = 'stripe' | 'free' | 'contact';

export interface ServerCatalogEntry {
  kind: ServerCatalogKind;
  // `null` when the price isn't list-priced (Pro).
  priceUsd: number | null;
  productName: string;
  description: string;
}

export const serverCatalog: Record<PricingTierSlug, ServerCatalogEntry> = {
  starter: {
    kind: 'free',
    priceUsd: 0,
    productName: 'Starter subscription',
    description: `${brand.name}'s Starter plan — continuous monitoring for solo developers.`,
  },
  pro: {
    kind: 'stripe',
    priceUsd: 49,
    productName: 'Team subscription',
    description: `${brand.name}'s Team plan — continuous vulnerability intelligence for teams.`,
  },
  enterprise: {
    kind: 'contact',
    priceUsd: null,
    productName: 'Pro subscription',
    description: `${brand.name}'s Pro plan — self-hosted control plane + named SLA.`,
  },
};

// JSON-LD price lookup: page-builder helper. Resolved server-only at
// the page render (the pricing page stays a Server Component) — but
// this file has no DB / fetch / server-only imports, so the seal is
// "rendered in a server context" rather than a runtime guard. The
// /pricing page reads this at module top via NUMERIC_TIER_PRICE.
export function getPricingCatalogPriceUsd(slug: PricingTierSlug): string | null {
  const entry = serverCatalog[slug];
  if (entry.priceUsd === null) return null;
  return String(entry.priceUsd);
}
