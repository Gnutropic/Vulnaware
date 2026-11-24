// @polsia:user-owned — public /pricing route. Server Component so it can export
// per-page metadata (POL-2616). Tier copy lives in src/lib/content/pricing.ts;
// this page is markup + composition only — no data fetch, no auth gate, no
// `headers()`/`cookies()`/`searchParams` reads, so it is statically
// prerenderable.
//
// CTAs deep-link to `/signup?tier=<slug>&trial=1`, which the tier-aware signup
// page narrows via `TieredTrialSignupTier.safeParse(...)` and renders the
// `TierSignupForm` island that runs through `/api/trial/tiered-signup`.

import { Check } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { EnterpriseContactSalesButton } from '@/components/custom/pricing/enterprise-contact-sales-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { brand } from '@/lib/brand';
import { pricingTiers } from '@/lib/content/pricing';
import { siteName } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Pricing',
  description: `Pick the ${brand.name} plan that fits your team. Start free with Starter, scale with Team, or get a custom Pro plan with self-hosted control plane, SSO, and a 99.9% SLA.`,
  alternates: { canonical: '/pricing' },
  openGraph: {
    title: `Pricing · ${siteName}`,
    description:
      'Three plans for teams that need continuous vulnerability intelligence without the analyst backlog. Start free; scale without re-platforming.',
    url: '/pricing',
  },
};

export default function PricingPage() {
  return (
    <main className="relative">
      {/* ===================== HERO ===================== */}
      <section
        aria-labelledby="pricing-heading"
        className="relative isolate overflow-hidden border-b border-border"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(70%_55%_at_82%_-10%,color-mix(in_oklab,var(--brand-400)_28%,transparent),transparent_60%),radial-gradient(45%_35%_at_8%_0%,color-mix(in_oklab,var(--brand-500)_18%,transparent),transparent_60%)]"
        />

        <div className="container-page flex flex-col items-center gap-5 pb-section-lg pt-section-lg text-center">
          <p className="text-eyebrow">Pricing</p>
          <h1
            id="pricing-heading"
            className="max-w-3xl font-display text-display tracking-tight text-foreground"
          >
            Pick the plan that fits{' '}
            <span className="block text-brand-500">your team&apos;s surface.</span>
          </h1>
          <p className="max-w-xl text-body-lg text-muted-foreground">
            {`Every ${brand.name} plan runs the same exploitability-ranked engine — the difference is
            scope, integrations, and who owns the control plane. Start free, scale without
            re-platforming, and bring your own cloud when regulators ask.`}
          </p>
        </div>
      </section>

      {/* ===================== TIER GRID ===================== */}
      <section aria-labelledby="tiers-heading" className="container-page section-lg scroll-mt-20">
        <h2 id="tiers-heading" className="sr-only">
          Plans
        </h2>

        <div className="grid gap-6 md:grid-cols-3">
          {pricingTiers.map((tier) => {
            const isMostPopular = tier.highlighted === true;
            return (
              <Card
                key={tier.slug}
                className={
                  isMostPopular
                    ? 'lift relative flex flex-col border-brand-500/70 bg-card shadow-brand ring-1 ring-brand-500/40'
                    : 'lift relative flex flex-col border-border/80 bg-card'
                }
              >
                {isMostPopular ? (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute -top-px left-1/2 -translate-x-1/2 -translate-y-1/2"
                  >
                    <Badge className="rounded-full px-2.5 py-1 shadow-sm">Most popular</Badge>
                  </span>
                ) : null}

                <CardHeader className="gap-2">
                  <CardTitle className="font-display text-h3 tracking-tight text-foreground">
                    {tier.name}
                  </CardTitle>
                  <CardDescription className="text-body text-muted-foreground">
                    {tier.tagline}
                  </CardDescription>
                </CardHeader>

                <CardContent className="flex flex-1 flex-col gap-6">
                  <div className="flex flex-col gap-1">
                    <p
                      className={
                        isMostPopular
                          ? 'font-display text-display leading-none tracking-tight text-brand-500'
                          : 'font-display text-display leading-none tracking-tight text-foreground'
                      }
                    >
                      {tier.monthlyPriceLabel}
                    </p>
                    {tier.priceSubLabel ? (
                      <p className="text-small text-muted-foreground">{tier.priceSubLabel}</p>
                    ) : null}
                  </div>

                  <Separator className="bg-border/70" />

                  <ul className="flex flex-col gap-2.5">
                    {tier.features.map((feat) => (
                      <li key={feat} className="flex items-start gap-2.5 text-body text-foreground">
                        <Check
                          className={
                            isMostPopular
                              ? 'mt-0.5 size-4 shrink-0 text-brand-500'
                              : 'mt-0.5 size-4 shrink-0 text-muted-foreground'
                          }
                          aria-hidden
                        />
                        <span className="text-body">{feat}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>

                <CardFooter className="mt-auto flex flex-col gap-2 pt-2">
                  <Button
                    asChild
                    size="lg"
                    className={isMostPopular ? 'w-full shadow-brand' : 'w-full'}
                  >
                    <Link href={tier.ctaHref}>{tier.ctaLabel}</Link>
                  </Button>
                  {tier.slug === 'enterprise' ? (
                    <EnterpriseContactSalesButton variant="outline" className="w-full" size="lg" />
                  ) : null}
                </CardFooter>
              </Card>
            );
          })}
        </div>

        <p className="mt-10 text-center text-small text-muted-foreground">
          {`Every plan starts with a 14-day trial — no credit card, no override. Cancel or upgrade
          from inside the workspace at any time.`}
        </p>
      </section>
    </main>
  );
}
