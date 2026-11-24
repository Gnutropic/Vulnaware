// @polsia:user-owned — public /changelog route. Server Component so it can
// export per-page metadata (POL-2616). Hero + CTA + the typed
// <ChangelogList/> island + a structured-data CreativeWork + ItemList so
// search engines can surface each update individually.
//
// The data plane rule: this page does NOT fetch or query; the client island
// reads through /api/changelog and the shared zod contract. No Prisma, no
// session seam, no Server Action.

import { ArrowRight, Sparkles } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ChangelogList } from '@/components/custom/changelog/changelog-list';
import { Button } from '@/components/ui/button';
import { brand } from '@/lib/brand';
import { CHANGELOG_ENTRIES } from '@/lib/content/changelog';
import { siteName } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Changelog',
  description: `See shipped customer-facing updates to ${brand.name}.`,
  alternates: { canonical: '/changelog' },
  openGraph: {
    title: `Changelog · ${siteName}`,
    description: `See shipped customer-facing updates to ${brand.name}.`,
    url: '/changelog',
  },
};

const CHANGELOG_CREATIVE_WORK_LD = {
  '@context': 'https://schema.org',
  '@type': 'CreativeWork',
  name: `${brand.name} changelog`,
  url: '/changelog',
  description: `Shipped customer-facing updates to ${brand.name}.`,
  inLanguage: 'en',
};

const CHANGELOG_ITEM_LIST_LD = {
  '@context': 'https://schema.org',
  '@type': 'ItemList',
  itemListElement: CHANGELOG_ENTRIES.map((entry, index) => ({
    '@type': 'ListItem',
    position: index + 1,
    name: entry.title,
    url: `/changelog#entry-${entry.id}`,
  })),
};

const CHANGELOG_BREADCRUMB_LD = {
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Home', item: '/' },
    { '@type': 'ListItem', position: 2, name: 'Changelog', item: '/changelog' },
  ],
};

export default function ChangelogPage() {
  return (
    <main className="relative">
      {/* ===================== HERO ===================== */}
      <section
        aria-labelledby="changelog-hero-heading"
        className="relative isolate overflow-hidden border-b border-border"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(70%_55%_at_82%_-10%,color-mix(in_oklab,var(--brand-400)_28%,transparent),transparent_60%),radial-gradient(45%_35%_at_8%_0%,color-mix(in_oklab,var(--brand-500)_18%,transparent),transparent_60%)]"
        />
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-72 w-full opacity-[0.16] text-border"
        >
          <title>Decorative grid background</title>
          <defs>
            <pattern id="changelog-grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="currentColor" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#changelog-grid)" />
        </svg>

        <div className="container-page grid gap-6 pb-section-lg pt-section-lg lg:grid-cols-[1.1fr_0.9fr] lg:items-end lg:gap-12">
          <div className="flex flex-col gap-5">
            <p className="text-eyebrow inline-flex items-center gap-2">
              <span aria-hidden className="size-1.5 rounded-full bg-brand-500" />
              <span>Changelog</span>
            </p>
            <h1
              id="changelog-hero-heading"
              className="font-display text-display tracking-tight text-foreground"
            >
              Every shipped change to {brand.name},{' '}
              <span className="block text-brand-500">in one feed.</span>
            </h1>
            <p className="max-w-xl text-body-lg text-muted-foreground">
              {`Customer-facing features and improvements for ${brand.name}, collected in one place.`}
            </p>
          </div>

          <dl className="grid grid-cols-3 gap-x-4 gap-y-1 rounded-[var(--radius-lg)] border border-border bg-card/60 p-5 shadow-sm backdrop-blur-sm">
            <div className="flex flex-col">
              <dt className="text-caption uppercase tracking-wider text-muted-foreground/80">
                Updates
              </dt>
              <dd className="font-display text-h4 text-foreground">{CHANGELOG_ENTRIES.length}</dd>
              <dd className="text-small text-muted-foreground">Shipped product work</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-caption uppercase tracking-wider text-muted-foreground/80">
                Order
              </dt>
              <dd className="font-display text-h4 text-foreground">As listed</dd>
              <dd className="text-small text-muted-foreground">Supplied update order</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-caption uppercase tracking-wider text-muted-foreground/80">
                Scope
              </dt>
              <dd className="font-display text-h4 text-foreground">Customer-facing</dd>
              <dd className="text-small text-muted-foreground">Features and improvements</dd>
            </div>
          </dl>
        </div>
      </section>

      {/* ===================== CTA STRIP ===================== */}
      <section
        aria-labelledby="changelog-cta-heading"
        className="container-page section-lg scroll-mt-20"
      >
        <div className="relative isolate overflow-hidden rounded-[var(--radius-2xl)] border border-border bg-card px-6 py-12 shadow-md sm:px-10 lg:px-14">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_60%_at_12%_0%,color-mix(in_oklab,var(--brand-500)_22%,transparent),transparent_55%),radial-gradient(45%_55%_at_100%_100%,color-mix(in_oklab,var(--brand-400)_18%,transparent),transparent_60%)]"
          />

          <div className="flex flex-col items-start gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex max-w-2xl flex-col gap-2">
              <p className="text-eyebrow inline-flex items-center gap-2">
                <Sparkles className="size-3.5 text-brand-500" aria-hidden />
                <span>Want to read the announcements?</span>
              </p>
              <h2
                id="changelog-cta-heading"
                className="font-display text-h2 tracking-tight text-foreground"
              >
                Follow the {brand.name} blog for more product updates.
              </h2>
              <p className="text-body text-muted-foreground">
                Visit the blog for product announcements and longer updates.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button asChild className="shadow-brand">
                <Link href="/blog">
                  Read the blog <ArrowRight className="ml-1.5 size-4" aria-hidden />
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/signup">Start a workspace</Link>
              </Button>
              <Button asChild variant="outline">
                <Link
                  href={`mailto:vulnaware@polsia.app?subject=${encodeURIComponent(`${brand.name} changelog question`)}`}
                >
                  Email the team
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* ===================== CHANGELOG LIST ===================== */}
      <section
        aria-labelledby="changelog-list-heading"
        className="container-page section-lg scroll-mt-20"
      >
        <h2 id="changelog-list-heading" className="sr-only">
          Recently shipped updates
        </h2>

        <ChangelogList />
      </section>

      {/* Structured data — CreativeWork identifies the surface itself;
          ItemList enumerates each shipped update. Built from the same
          const the API route reads, so the schema and rendered list stay
          in the same authored order. */}
      <script type="application/ld+json">{JSON.stringify(CHANGELOG_CREATIVE_WORK_LD)}</script>
      <script type="application/ld+json">{JSON.stringify(CHANGELOG_ITEM_LIST_LD)}</script>
      <script type="application/ld+json">{JSON.stringify(CHANGELOG_BREADCRUMB_LD)}</script>
    </main>
  );
}
