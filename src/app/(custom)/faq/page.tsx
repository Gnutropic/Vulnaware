// @polsia:user-owned — public /faq route. Server Component so it can export
// per-page metadata. Copy references /pricing, /security, and the home trial
// anchor; the layout reuses /security's FAQPage JSON-LD pattern so search
// engines can lift answers directly, and pairs an accordion (mobile) with
// always-visible stacked blocks (desktop ≥ md) so the answers don't require a
// tap to read on wide screens.

import { HelpCircle, MessageCircle, Sparkles } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { brand } from '@/lib/brand';
import { siteName } from '@/lib/site';

export const metadata: Metadata = {
  title: 'FAQ',
  description: `The ten questions ${brand.name} prospects ask before they sign — grouped under Capabilities, Integrations, Security & Data, Pricing, and Getting Started. Cross-links to /pricing and /security.`,
  alternates: { canonical: '/faq' },
  openGraph: {
    title: `FAQ · ${siteName}`,
    description: `Coverage scope, integrations, pricing tiers, what a 14-day trial unlocks, onboarding time to first scan, and how ${brand.name} handles customer data + tenant isolation.`,
    url: '/faq',
  },
};

const CONTACT_EMAIL = brand.contactEmail;

interface FaqEntry {
  q: string;
  /** Plain-text answer for JSON-LD (no JSX). Mirror of the rendered copy
   *  but stripped of links — keeps the structured data parser-safe. */
  a: string;
  /** JSX answer for the on-page view (with links). */
  body: ReactNode;
}

interface FaqGroup {
  title: string;
  items: FaqEntry[];
}

const FAQ_TEXT_LINK =
  'inline-block font-medium text-foreground underline-offset-4 transition-colors hover:text-brand-500 hover:underline';

const FAQ_GROUPS: FaqGroup[] = [
  {
    title: 'Capabilities',
    items: [
      {
        q: 'What do you actually cover, and how do you scan it?',
        a: `${brand.name} covers the full surface you can stand a workspace around: continuous external-surface monitoring on every domain + subdomain you own, authenticated internal scanning at protocol depth, cloud-posture review across AWS, Azure, and GCP, dynamic application testing for live services, and software-composition analysis + SBOM tracking against your dependency graph. Findings come back ranked by exploitability against your real environment rather than a generic CVSS pull. For the precise scope list see the home page capabilities.`,
        body: (
          <>
            {`${brand.name} covers the full surface you can stand a workspace around: continuous
				external-surface monitoring on every domain + subdomain you own, authenticated
				internal scanning at protocol depth, cloud-posture review across AWS, Azure, and
				GCP, dynamic application testing for live services, and software-composition
				analysis + SBOM tracking against your dependency graph. Findings come back ranked
				by exploitability against your real environment rather than a generic CVSS pull.
				For the precise scope list see the `}
            <Link href="/#capabilities" className={FAQ_TEXT_LINK}>
              home page capabilities
            </Link>
            .
          </>
        ),
      },
      {
        q: 'How is exploitability ranked against my environment instead of a generic CVSS pull?',
        a: 'Each finding is rescored against your actual asset context: is the affected service internet-facing, what auth sits in front, does your stack use the vulnerable code path, are there compensating controls (WAF, EDR, network policy) already in place, and is there a public exploit toolkit for this CVE? The composite score blends exploit availability, asset reachability, and impact — so two customers with the same CVE on the same library can see materially different priorities. The scorer is explainable: every finding shows the inputs that drove its rank.',
        body: (
          <>
            {`Each finding is rescored against your actual asset context: is the affected
				service internet-facing, what auth sits in front, does your stack use the
				vulnerable code path, are there compensating controls (WAF, EDR, network
				policy) already in place, and is there a public exploit toolkit for this
				CVE? The composite score blends exploit availability, asset reachability,
				and impact — so two customers with the same CVE on the same library can see
				materially different priorities. The scorer is `}
            <em>explainable</em>
            {`: every finding shows the inputs that drove its rank.`}
          </>
        ),
      },
    ],
  },
  {
    title: 'Integrations',
    items: [
      {
        q: 'Which integrations do you ship out of the box?',
        a: 'CI/CD: ready-to-drop snippets for GitHub Actions, GitLab CI, and Jenkins (signed-in users land on the /settings/integrations/ci-cd page). Notifications: shape-compatible webhooks for Jira, Linear, Slack, and PagerDuty, configurable from /settings/integrations/notifications so findings route into the workflow your on-call already uses. Cloud identity: read-only IAM import for AWS, Azure, and GCP so the same asset inventory spans accounts. Egress: the same webhook shape forwards findings into any SIEM or observability tool that accepts an HTTP webhook, so your detection pipeline sees results the moment they land.',
        body: (
          <>
            {`CI/CD: ready-to-drop snippets for GitHub Actions, GitLab CI, and Jenkins
				(signed-in users land on the `}
            <Link href="/settings/integrations/ci-cd" className={FAQ_TEXT_LINK}>
              CI/CD integrations
            </Link>
            {` page). Notifications: shape-compatible webhooks for Jira, Linear, Slack, and
				PagerDuty, configurable from `}
            <Link href="/settings/integrations/notifications" className={FAQ_TEXT_LINK}>
              notifications settings
            </Link>
            {` so findings route into the workflow your on-call already uses. Cloud
				identity: read-only IAM import for AWS, Azure, and GCP so the same asset
				inventory spans accounts. Egress: the same webhook shape forwards
				findings into any SIEM or observability tool that accepts an HTTP
				webhook, so your detection pipeline sees results the moment they
				land.`}
          </>
        ),
      },
      {
        q: 'Can findings route to my SIEM or observability stack? What does the webhook shape look like?',
        a: 'Yes — outbound webhooks subscribe to finding.created, finding.updated, and finding.resolved events and POST a JSON envelope with the same field names used in the dashboard API. Headers carry a signed payload (HMAC-SHA256 over the raw body) so your webhook receiver can verify authenticity. Splunk, Datadog, Elastic, New Relic, and any HTTP-receiving SIEM accept the shape with no translation; webhook configuration lives under /settings/integrations/notifications for signed-in workspaces.',
        body: (
          <>
            {`Yes — outbound webhooks subscribe to `}
            <code className="rounded bg-muted px-1.5 py-0.5 text-caption">finding.created</code>
            {`, `}
            <code className="rounded bg-muted px-1.5 py-0.5 text-caption">finding.updated</code>
            {`, and `}
            <code className="rounded bg-muted px-1.5 py-0.5 text-caption">finding.resolved</code>
            {` events and POST a JSON envelope with the same field names used in the dashboard
				API. Headers carry a signed payload (HMAC-SHA256 over the raw body) so your
				webhook receiver can verify authenticity. Splunk, Datadog, Elastic, New
				Relic, and any HTTP-receiving SIEM accept the shape with no translation;
				webhook configuration lives under the `}
            <Link href="/settings/integrations/notifications" className={FAQ_TEXT_LINK}>
              notifications settings
            </Link>
            {` page for signed-in workspaces.`}
          </>
        ),
      },
    ],
  },
  {
    title: 'Security & Data',
    items: [
      {
        q: 'How do you handle customer data and workspace isolation?',
        a: 'Full answer lives on the Security page: region pinning, AES-256 encryption at rest, TLS 1.2+ in transit, per-workspace data-layer isolation, and signed deletion receipts on cancellation.',
        body: (
          <>
            {`Full answer lives on the `}
            <Link href="/security" className={FAQ_TEXT_LINK}>
              Security page
            </Link>
            {`: region pinning, AES-256 encryption at rest, TLS 1.2+ in transit,
				per-workspace data-layer isolation, and signed deletion receipts on
				cancellation.`}
          </>
        ),
      },
      {
        q: 'What is the data retention window and how are deletion receipts issued?',
        a: 'Default retention is 13 months of findings + scan history so annual trend reporting has a full year to work against; Enterprise contracts can pin a longer (or shorter) window in the MSA. On cancellation, the workspace exports as a single tarball (assets, findings, audit trail, SBOMs, reports) and we run a hard purge of the live database plus all in-region backups. A signed deletion receipt — a JSON document with the workspace ID, purge timestamp, and an RSA signature you can verify against our public key — is delivered within one business day and is suitable evidence for your internal compliance ticket.',
        body: (
          <>
            {`Default retention is 13 months of findings + scan history so annual trend
				reporting has a full year to work against; Enterprise contracts can pin a
				longer (or shorter) window in the MSA. On cancellation, the workspace
				exports as a single tarball (assets, findings, audit trail, SBOMs, reports)
				and we run a hard purge of the live database plus all in-region backups.
				A `}
            <strong>signed deletion receipt</strong>
            {` — a JSON document with the workspace ID, purge timestamp, and an RSA signature
				you can verify against our public key — is delivered within one business
				day and is suitable evidence for your internal compliance ticket. The full
				data-handling story lives on the `}
            <Link href="/security" className={FAQ_TEXT_LINK}>
              Security page
            </Link>
            {`.`}
          </>
        ),
      },
    ],
  },
  {
    title: 'Pricing',
    items: [
      {
        q: 'How do pricing tiers work — and what counts as an asset or scan?',
        a: 'Three tiers. Starter is free and runs continuous external-surface monitoring on 1 domain (up to 100 scans / month). Pro unlocks unlimited domains + subdomains across the external surface plus authenticated internal, dynamic application testing, and software-composition analysis + SBOM tracking. Enterprise layers on cloud-posture review, dynamic application testing, and software-composition analysis + SBOM tracking on top, with self-hosting for regulated teams. An asset is one discrete discovered or inventoried host/service tracked by your workspace; a scan is one full pass across the asset surface.',
        body: (
          <>
            {`Three tiers. Starter is free and runs continuous external-surface monitoring on
				1 domain (up to 100 scans / month). Pro unlocks unlimited domains + subdomains
				across the external surface plus authenticated internal, dynamic application
				testing, and software-composition analysis + SBOM tracking. Enterprise layers
				on cloud-posture review, dynamic application testing, and software-composition
				analysis + SBOM tracking on top, with self-hosting for regulated teams. An `}
            <strong>asset</strong>
            {` is one discrete discovered or inventoried host/service tracked by your
				workspace; a `}
            <strong>scan</strong>
            {` is one full pass across the asset surface. Full tier grid on the `}
            <Link href="/pricing" className={FAQ_TEXT_LINK}>
              pricing
            </Link>
            {` page.`}
          </>
        ),
      },
      {
        q: 'What happens when I exceed my tier’s scan allotment?',
        a: 'We never block a scan mid-flight — exceeding your monthly scan allotment queues background jobs at lower priority rather than refusing them, so you keep coverage while we send a heads-up. On Starter, scans beyond the free allotment pause until the next billing cycle (or you upgrade). On Pro and Enterprise, overage is billed at the published per-1000-scan rate and shows up on the next invoice with its own line item so finance can track it. You can always raise the soft cap yourself from /settings/billing to silence the heads-ups without upgrading.',
        body: (
          <>
            {`We never block a scan mid-flight — exceeding your monthly scan allotment queues
				background jobs at lower priority rather than refusing them, so you keep
				coverage while we send a heads-up. On Starter, scans beyond the free
				allotment pause until the next billing cycle (or you upgrade). On Pro and
				Enterprise, overage is billed at the published per-1000-scan rate and shows
				up on the next invoice with its own line item so finance can track it. You
				can always `}
            <Link href="/pricing" className={FAQ_TEXT_LINK}>
              raise the soft cap yourself
            </Link>
            {` to silence the heads-ups without upgrading.`}
          </>
        ),
      },
    ],
  },
  {
    title: 'Getting Started',
    items: [
      {
        q: 'What does the 14-day trial actually include?',
        a: 'Every tier is trialable for 14 days with no credit card. The Starter trial provisions a workspace, seeds it with a sample internet-facing asset inventory, and runs the same exploitability-ranked engine Pro teams use — no feature gating at the Starter tier. Pro and Enterprise can be trialed self-serve via the tiered signup path; full tier scope is on the pricing page.',
        body: (
          <>
            {`Every tier is trialable for 14 days with no credit card. The Starter trial
				provisions a workspace, seeds it with a sample internet-facing asset inventory,
				and runs the same exploitability-ranked engine Pro teams use — no feature
				gating at the Starter tier. Pro and Enterprise can be trialed self-serve via the
				tiered signup path; full tier scope is on the `}
            <Link href="/pricing" className={FAQ_TEXT_LINK}>
              pricing
            </Link>
            {` page, or jump straight to the `}
            <Link href="/#trial" className={FAQ_TEXT_LINK}>
              trial signup
            </Link>
            {` on the home page.`}
          </>
        ),
      },
      {
        q: 'How long from kickoff to the first prioritized report?',
        a: 'Discovery begins within 24 hours of provisioning. The first exploitability-ranked report lands within 72 hours for a small external surface, and within one week for a mid-sized or full estate spanning external + internal + cloud + application. The full timeline is on the home page, or you can start the trial and see it from the inside.',
        body: (
          <>
            {`Discovery begins within 24 hours of provisioning. The first
				exploitability-ranked report lands within 72 hours for a small external
				surface, and within one week for a mid-sized or full estate spanning
				external + internal + cloud + application. The full timeline is on
				the home page, or you can `}
            <Link href="/#trial" className={FAQ_TEXT_LINK}>
              start the trial
            </Link>
            {` and see it from the inside.`}
          </>
        ),
      },
    ],
  },
];

const FAQ_ITEMS: FaqEntry[] = FAQ_GROUPS.flatMap((g) => g.items);

const FAQ_JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQ_ITEMS.map((f) => ({
    '@type': 'Question',
    name: f.q,
    acceptedAnswer: { '@type': 'Answer', text: f.a },
  })),
};

// Stable id per group, used by both the mobile accordion (group <AccordionItem>
// value) and the desktop stacked blocks (aria-labelledby anchor). Keeps the
// mobile and desktop views addressable by the same heading id.
const groupId = (title: string) =>
  `faq-group-${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')}`;

const itemValue = (title: string, q: string) =>
  `${groupId(title)}-${q
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40)}`;

export default function FaqPage() {
  const reachOutSubject = encodeURIComponent(`${brand.name} - question`);
  return (
    <main className="relative">
      {/* ===================== HERO ===================== */}
      <section
        aria-labelledby="faq-hero-heading"
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
            <pattern id="faq-grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="currentColor" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#faq-grid)" />
        </svg>

        <div className="container-page grid gap-6 pb-section-lg pt-section-lg lg:grid-cols-[1.1fr_0.9fr] lg:items-end lg:gap-12">
          <div className="flex flex-col gap-5">
            <p className="text-eyebrow inline-flex items-center gap-2">
              <HelpCircle className="size-3.5 text-brand-500" aria-hidden />
              <span>Frequently asked</span>
            </p>
            <h1
              id="faq-hero-heading"
              className="font-display text-display tracking-tight text-foreground"
            >
              The ten questions{' '}
              <span className="block text-brand-500">prospects ask before they sign.</span>
            </h1>
            <p className="max-w-xl text-body-lg text-muted-foreground">
              {`Coverage scope, integrations, pricing, the 14-day trial, and how
							${brand.name} handles your data + workspace isolation. If your question
							isn't here, the pricing and security pages go deeper — and a named
							human on the team will answer inside one business day.`}
            </p>
          </div>

          <dl className="grid grid-cols-3 gap-x-4 gap-y-1 rounded-[var(--radius-lg)] border border-border bg-card/60 p-5 shadow-sm backdrop-blur-sm">
            <div className="flex flex-col">
              <dt className="text-caption uppercase tracking-wider text-muted-foreground/80">
                Questions
              </dt>
              <dd className="font-display text-h4 text-foreground">10 answered</dd>
              <dd className="text-small text-muted-foreground">Top objections</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-caption uppercase tracking-wider text-muted-foreground/80">
                Deep dives
              </dt>
              <dd className="font-display text-h4 text-foreground">5 categories</dd>
              <dd className="text-small text-muted-foreground">Capabilities → trial</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-caption uppercase tracking-wider text-muted-foreground/80">
                Trial
              </dt>
              <dd className="font-display text-h4 text-foreground">14 days</dd>
              <dd className="text-small text-muted-foreground">No credit card</dd>
            </div>
          </dl>
        </div>
      </section>

      {/* ===================== FAQ ACCORDION + STACKED BLOCKS ===================== */}
      <section
        id="faq"
        aria-labelledby="faq-questions-heading"
        className="container-page section-lg scroll-mt-20"
      >
        <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr]">
          <div className="flex flex-col gap-3">
            <p className="text-eyebrow">Prospect FAQ</p>
            <h2
              id="faq-questions-heading"
              className="font-display text-h1 tracking-tight text-foreground"
            >
              The questions teams ask on the first call.
            </h2>
            <p className="max-w-prose text-body text-muted-foreground">
              If your question isn&apos;t here, write to{' '}
              <a
                href={`mailto:${CONTACT_EMAIL}?subject=${reachOutSubject}`}
                className="font-medium text-foreground underline-offset-4 transition-colors hover:text-brand-500 hover:underline"
              >
                {CONTACT_EMAIL}
              </a>{' '}
              and a named human will respond within one business day.
            </p>

            {/* In-page category index — links scroll-anchor to each group's id
                on desktop (where the stacked blocks live) and to the matching
                mobile accordion heading on narrow screens. */}
            <nav aria-label="FAQ categories" className="mt-3 hidden flex-col gap-2 md:flex">
              <p className="text-caption uppercase tracking-wider text-muted-foreground/80">
                Jump to
              </p>
              <ul className="flex flex-col gap-1.5">
                {FAQ_GROUPS.map((g) => (
                  <li key={g.title}>
                    <a
                      href={`#${groupId(g.title)}`}
                      className="font-medium text-foreground underline-offset-4 transition-colors hover:text-brand-500 hover:underline"
                    >
                      {g.title}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          </div>

          {/* Mobile (below md): single Radix accordion; each group opens as a
              nested <AccordionItem> with the group title as the trigger and
              the group's items inside its <AccordionContent>. */}
          <div className="md:hidden">
            <Accordion
              type="single"
              collapsible
              className="rounded-[var(--radius-lg)] border border-border bg-card px-2 shadow-sm"
            >
              {FAQ_GROUPS.map((g) => (
                <AccordionItem key={g.title} value={groupId(g.title)} className="border-b-0">
                  <AccordionTrigger className="px-4 font-display text-body-lg text-foreground">
                    {g.title}
                  </AccordionTrigger>
                  <AccordionContent className="px-4 pb-2">
                    <Accordion
                      type="single"
                      collapsible
                      className="ml-1 border-l border-border pl-2"
                    >
                      {g.items.map((item) => (
                        <AccordionItem
                          key={item.q}
                          value={itemValue(g.title, item.q)}
                          className="border-b-0"
                        >
                          <AccordionTrigger className="px-3 text-left text-body font-medium text-foreground">
                            {item.q}
                          </AccordionTrigger>
                          <AccordionContent className="px-3 text-body text-muted-foreground">
                            {item.body}
                          </AccordionContent>
                        </AccordionItem>
                      ))}
                    </Accordion>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>

          {/* Desktop (md+): all answers always visible as stacked blocks so
              visitors don't have to tap to scan the page. Grouped under
              labeled group sections, each scroll-anchored by its id. */}
          <div className="hidden flex-col gap-8 md:flex">
            {FAQ_GROUPS.map((g) => (
              <section
                key={g.title}
                id={groupId(g.title)}
                aria-labelledby={`${groupId(g.title)}-title`}
                className="scroll-mt-20 rounded-[var(--radius-lg)] border border-border bg-card p-6 shadow-sm"
              >
                <p className="text-eyebrow inline-flex items-center gap-2">
                  <span aria-hidden className="size-1.5 rounded-full bg-brand-500" />
                  <span>{g.title}</span>
                </p>
                <h3
                  id={`${groupId(g.title)}-title`}
                  className="mt-1 font-display text-h3 tracking-tight text-foreground"
                >
                  {g.items.length} question{g.items.length === 1 ? '' : 's'} answered.
                </h3>
                <dl className="mt-5 flex flex-col gap-5">
                  {g.items.map((item) => (
                    <div
                      key={item.q}
                      className="flex flex-col gap-2 border-t border-border pt-5 first:border-t-0 first:pt-0"
                    >
                      <dt className="font-display text-body-lg text-foreground">{item.q}</dt>
                      <dd className="text-body text-muted-foreground">{item.body}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </div>
      </section>

      {/* ===================== TRIAL CTA ===================== */}
      <section
        aria-labelledby="faq-trial-heading"
        className="border-t border-border bg-muted/30 section-lg scroll-mt-20"
      >
        <div className="container-page grid gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
          <Card className="border-border/80 bg-card">
            <CardHeader className="gap-3">
              <span
                aria-hidden
                className="flex size-9 items-center justify-center rounded-[var(--radius)] bg-muted text-foreground"
              >
                <MessageCircle className="size-5" aria-hidden />
              </span>
              <CardTitle className="font-display text-h3 tracking-tight text-foreground">
                Didn&apos;t find your answer?
              </CardTitle>
              <CardDescription className="text-body text-muted-foreground">
                Send us a quick note with the question you actually need answered — we&apos;ll route
                it to whoever on the team owns that surface, not a generic inbox.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-3 pt-0">
              <Button asChild className="shadow-brand">
                <a href={`mailto:${CONTACT_EMAIL}?subject=${reachOutSubject}`}>Ask the team</a>
              </Button>
            </CardContent>
          </Card>

          <div className="flex flex-col gap-5">
            <p className="text-eyebrow inline-flex items-center gap-2">
              <Sparkles className="size-3.5 text-brand-500" aria-hidden />
              <span>Ready to start?</span>
            </p>
            <h2
              id="faq-trial-heading"
              className="font-display text-h1 tracking-tight text-foreground"
            >
              Spin up a workspace in under a minute.
            </h2>
            <p className="max-w-prose text-body-lg text-muted-foreground">
              {`Provision a 14-day ${brand.name} workspace, seed it with a sample
							internet-facing asset inventory + ranked CVEs, and land inside an
							authenticated dashboard. No credit card. Bring your team when
							you&apos;re ready.`}
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild size="lg" className="shadow-brand">
                <Link href="/#trial">Start your 14-day trial</Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link href="/pricing">Compare pricing</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Structured data: FAQPage so search engines can lift our answers
				directly into result snippets. JSON.stringify output only contains
				characters safe to live inside a <script> tag body. */}
      <script type="application/ld+json">{JSON.stringify(FAQ_JSON_LD)}</script>
    </main>
  );
}
