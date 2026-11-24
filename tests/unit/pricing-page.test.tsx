// @polsia:user-owned — regression test for the /pricing tier grid. Source-string
// assertions only — no @testing-library/react, no React render — so the file
// stays small and the test runs in milliseconds. Tier copy (names, CTA labels,
// ctaHref) lives in src/lib/pricing-tiers.ts; the page is markup + composition
// only, rendering the data via `tier.*` interpolation, so the literal tier
// names live in the data file, NOT in the page source.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const PRICING_PAGE = path.join(REPO_ROOT, 'src/app/(custom)/pricing/page.tsx');
const PRICING_TIERS = path.join(REPO_ROOT, 'src/lib/pricing-tiers.ts');

const readPage = (): string => readFileSync(PRICING_PAGE, 'utf8');
const readTiers = (): string => readFileSync(PRICING_TIERS, 'utf8');

describe('/pricing page rendering', () => {
  it('page file exists at src/app/(custom)/pricing/page.tsx', () => {
    expect(existsSync(PRICING_PAGE)).toBe(true);
  });

  it('renders tier cards via `pricingTiers.map` with `tier.name` interpolation', () => {
    const src = readPage();
    expect(src).toMatch(/pricingTiers\.map\(\(tier\)/);
    expect(src).toMatch(/\{tier\.name\}/);
  });

  it('branches on subscribeProductId before falling back to ctaHref / stripeUrl', () => {
    const src = readPage();
    // The Team tier renders through TeamSubscribeButton and bypasses
    // <Button asChild>; the page must read the flag from the data layer and
    // mount the island before the legacy branches.
    expect(src).toMatch(/subscribeProductId/);
    expect(src).toContain('TeamSubscribeButton');
    expect(src).toMatch(/href=\{tier\.ctaHref\}/);
  });

  it('tiers section landmark exists', () => {
    const src = readPage();
    expect(src).toContain('aria-labelledby="tiers-heading"');
  });

  it('hero dual-CTA strip exists between hero and tier grid', () => {
    const src = readPage();
    expect(src).toContain('aria-labelledby="pricing-cta-heading"');
    expect(src).toMatch(/href="\/signup"/);
    expect(src).toMatch(/href="\/contact"/);
  });
});

describe('/pricing JSON-LD', () => {
  it('emits four <script type="application/ld+json"> blocks', () => {
    const src = readPage();
    const matches = src.match(/type="application\/ld\+json"/g) ?? [];
    expect(matches.length).toBe(4);
  });

  it('JSON-LD source declares @type Product with a nested @type Offer', () => {
    const src = readPage();
    expect(src).toMatch(/'@type':\s*'Product'/);
    expect(src).toMatch(/'@type':\s*'Offer'/);
  });

  it('JSON-LD is built from pricingTiers using tier.name + tier.tagline', () => {
    const src = readPage();
    expect(src).toContain('PRICING_PRODUCT_LD');
    expect(src).toMatch(/PRICING_PRODUCT_LD\s*=\s*pricingTiers\.map/);
    expect(src).toMatch(/name:\s*tier\.name/);
    expect(src).toMatch(/description:\s*tier\.tagline/);
  });

  it('Enterprise offer omits `price` (uses `availability` PreOrder instead)', () => {
    const src = readPage();
    expect(src).toContain('https://schema.org/PreOrder');
    expect(src).toMatch(/enterprise:\s*null/);
  });

  it('emits an FAQPage JSON-LD block built from PRICING_FAQS', () => {
    const src = readPage();
    expect(src).toContain('PRICING_FAQ_LD');
    expect(src).toMatch(/PRICING_FAQ_LD\s*=\s*\{/);
    expect(src).toMatch(/'@type':\s*'FAQPage'/);
    expect(src).toMatch(/mainEntity:\s*PRICING_FAQS\.map/);
    expect(src).toMatch(/'@type':\s*'Question'/);
    expect(src).toMatch(/'@type':\s*'Answer'/);
    expect(src).toMatch(/name:\s*f\.q/);
    expect(src).toMatch(/text:\s*f\.a/);
  });
});

describe('src/lib/pricing-tiers.ts pricing data', () => {
  it('defines all three tier names: Starter, Team, Enterprise', () => {
    const src = readTiers();
    expect(src).toContain("name: 'Starter'");
    expect(src).toContain("name: 'Team'");
    expect(src).toContain("name: 'Enterprise'");
  });

  it('Starter CTA label is "Sign up free" and ctaHref is /signup', () => {
    const src = readTiers();
    expect(src).toContain("ctaLabel: 'Sign up free'");
    expect(src).toMatch(/ctaHref: '\/signup'/);
  });

  it('Team CTA label is "Subscribe" and uses subscribeProductId team_subscription', () => {
    const src = readTiers();
    expect(src).toContain("ctaLabel: 'Subscribe'");
    expect(src).toContain("subscribeProductId: 'team_subscription'");
    // The Team entry MUST NOT carry a ctaHref — the runtime checkout
    // (subscribeProductId branch) replaces it; keeping /contact there would
    // ship a dead destination anywhere the flag isn't honored.
    const teamBlock = src.match(/slug: 'pro'[\s\S]+?\}/)?.[0];
    expect(teamBlock).toBeTruthy();
    expect(teamBlock).not.toMatch(/ctaHref:/);
  });

  it('Enterprise CTA label is "Contact sales" and ctaHref is /contact', () => {
    const src = readTiers();
    expect(src).toContain("ctaLabel: 'Contact sales'");
    expect(src).toMatch(/ctaHref: '\/contact'/);
  });
});
