// @polsia:user-owned — public /terms route. Server Component so it can
// export per-page metadata. Copy is constant; no data fetch, no auth gate.

import { Scale, ShieldCheck } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { brand } from '@/lib/brand';

export const metadata: Metadata = {
  title: 'Terms',
  description: `The terms governing use of ${brand.name} — eligibility, acceptable use, plans and billing, IP, confidentiality, disclaimers, liability, indemnification, termination, governing law, and how we change these terms.`,
  alternates: { canonical: '/terms' },
  openGraph: {
    title: `Terms · ${brand.name}`,
    description:
      'The Master Terms governing VulnAware — eligibility, acceptable use, plans and billing, IP, confidentiality, disclaimers, liability cap, indemnification, termination, and governing law.',
    url: '/terms',
  },
};

const CONTACT_EMAIL = brand.contactEmail;

const PROHIBITED_USES = [
  'Scanning systems you do not own or operate, or outside the written scope of an engagement.',
  'Using the platform as a general-purpose data store for assets you have no entitlement to scan.',
  'Reselling findings, remediation runs, or scanner output as a service to a third party without written permission.',
  'Reverse-engineering, decompiling, or extracting the proprietary scoring model or remediation engine.',
];

const IP_BULLETS = [
  `${brand.name} retains all intellectual property in the platform — the scanner, scoring model, UI, documentation, and trademarks.`,
  'You retain all intellectual property in your data — asset inventories, configurations, scan artefacts, and findings generated from your assets.',
  'Feedback you send us (suggestions, bug reports, scoring notes) is non-confidential and we may use it without restriction.',
];

const CONFIDENTIALITY_CARVE_OUTS = [
  'Information that is or becomes publicly known through no fault of the receiving party.',
  'Information already known to the receiving party before disclosure, evidenced in writing.',
  'Information independently developed by the receiving party without use of the disclosing party&apos;s information.',
  'Information required to be disclosed by law, regulation, or court order — with prompt notice to the disclosing party where lawful.',
];

const TERMS_WEBPAGE_LD = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: `Terms · ${brand.name}`,
  url: '/terms',
  description: `The Master Terms governing use of ${brand.name} — eligibility, acceptable use, plans and billing, IP, confidentiality, disclaimers, liability, indemnification, and governing law.`,
};

const TERMS_BREADCRUMB_LD = {
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: [
    {
      '@type': 'ListItem',
      position: 1,
      name: 'Home',
      item: '/',
    },
    {
      '@type': 'ListItem',
      position: 2,
      name: 'Terms',
      item: '/terms',
    },
  ],
};

export default function TermsPage() {
  return (
    <main className="relative">
      {/* ===================== HERO ===================== */}
      <section
        aria-labelledby="terms-hero-heading"
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
            <pattern id="terms-grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="currentColor" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#terms-grid)" />
        </svg>

        <div className="container-page grid gap-6 pb-section-lg pt-section-lg lg:grid-cols-[1.1fr_0.9fr] lg:items-end lg:gap-12">
          <div className="flex flex-col gap-5">
            <p className="text-eyebrow inline-flex items-center gap-2">
              <Scale className="size-3.5 text-brand-500" aria-hidden />
              <span>Terms of service</span>
            </p>
            <h1
              id="terms-hero-heading"
              className="font-display text-display tracking-tight text-foreground"
            >
              The contract behind <span className="block text-brand-500">every workspace.</span>
            </h1>
            <p className="max-w-xl text-body-lg text-muted-foreground">
              {`These are the terms that govern your use of ${brand.name}. The section
              bookmarks below mirror the structure of the Master Services Agreement — legal
              teams can read straight through, founders can re-read the operational parts.`}
            </p>
          </div>

          <dl className="grid grid-cols-3 gap-x-4 gap-y-1 rounded-[var(--radius-lg)] border border-border bg-card/60 p-5 shadow-sm backdrop-blur-sm">
            <div className="flex flex-col">
              <dt className="text-caption uppercase tracking-wider text-muted-foreground/80">
                Effective
              </dt>
              <dd className="font-display text-h4 text-foreground">Today</dd>
              <dd className="text-small text-muted-foreground">30 days&apos; notice on changes</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-caption uppercase tracking-wider text-muted-foreground/80">
                Liability cap
              </dt>
              <dd className="font-display text-h4 text-foreground">12-mo fees</dd>
              <dd className="text-small text-muted-foreground">Standard B2B SaaS formula</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-caption uppercase tracking-wider text-muted-foreground/80">
                Venue
              </dt>
              <dd className="font-display text-h4 text-foreground">Delaware</dd>
              <dd className="text-small text-muted-foreground">Federal &amp; state courts</dd>
            </div>
          </dl>
        </div>
      </section>

      {/* ===================== ELIGIBILITY & ACCOUNT ===================== */}
      <section
        aria-labelledby="eligibility-heading"
        className="container-page section-lg scroll-mt-20"
      >
        <div className="flex max-w-prose flex-col gap-3">
          <p className="text-eyebrow">1 · Eligibility &amp; account</p>
          <h2
            id="eligibility-heading"
            className="font-display text-h1 tracking-tight text-foreground"
          >
            Who may use the service.
          </h2>
          <p className="text-body-lg text-muted-foreground">
            The service is sold to organisations and to individuals acting on their behalf. If you
            sign up on behalf of an entity, you represent that you have authority to bind that
            entity to these terms.
          </p>
        </div>

        <div className="mt-8 grid gap-6 md:grid-cols-2">
          {[
            {
              key: 'age',
              title: 'Age & entity type',
              body: 'You must be at least 18 years old and either a natural person acting in a business capacity or a duly-formed legal entity. Consumer-only use of the service is not supported.',
            },
            {
              key: 'authority',
              title: 'Authority',
              body: 'If you sign up on behalf of a company, you confirm you have authority to bind that company to these terms. Workspace Owners are the natural legal contact for notices and billing.',
            },
          ].map((c) => (
            <Card key={c.key} className="lift flex flex-col border-border/80 bg-card">
              <CardHeader className="gap-3">
                <CardTitle className="font-display text-h3 tracking-tight text-foreground">
                  {c.title}
                </CardTitle>
                <CardDescription className="text-body text-muted-foreground">
                  {c.body}
                </CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </section>

      {/* ===================== THE SERVICE & ACCEPTABLE USE ===================== */}
      <section
        aria-labelledby="service-use-heading"
        className="border-t border-border bg-muted/30 section-lg scroll-mt-20"
      >
        <div className="container-page grid gap-10 lg:grid-cols-[1fr_1.4fr]">
          <div className="flex flex-col gap-3">
            <p className="text-eyebrow">2 · The service &amp; acceptable use</p>
            <h2
              id="service-use-heading"
              className="font-display text-h1 tracking-tight text-foreground"
            >
              What you are buying, and the uses that are off-limits.
            </h2>
            <p className="max-w-prose text-body-lg text-muted-foreground">
              {`${brand.name} is an autonomous vulnerability scanner — a continuous-monitoring SaaS that
              ranks findings against your asset context and ships remediation payloads alongside
              every finding. The list below is the narrow set of uses we do not support.`}
            </p>
          </div>

          <Card className="border-border/80 bg-card">
            <CardHeader className="gap-2">
              <Badge variant="outline" className="w-fit rounded-full font-normal">
                Prohibited uses
              </Badge>
              <CardTitle className="font-display text-h3 tracking-tight text-foreground">
                Acceptable-use limits.
              </CardTitle>
              <CardDescription className="text-body text-muted-foreground">
                Breach of these limits is grounds for suspension and termination of the workspace
                under the Master Services Agreement.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <ul className="flex flex-col gap-3">
                {PROHIBITED_USES.map((b) => (
                  <li key={b} className="flex items-start gap-2.5 text-body text-foreground">
                    <span
                      aria-hidden
                      className="mt-2 size-1.5 shrink-0 rounded-full bg-brand-500"
                    />
                    <span className="text-body">{b}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* ===================== PLANS, FEES & BILLING ===================== */}
      <section
        aria-labelledby="plans-billing-heading"
        className="border-t border-border container-page section-lg scroll-mt-20"
      >
        <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr]">
          <div className="flex flex-col gap-3">
            <p className="text-eyebrow">3 · Plans, fees, and billing</p>
            <h2
              id="plans-billing-heading"
              className="font-display text-h1 tracking-tight text-foreground"
            >
              Pricing lives on a separate page — this section only fixes the terms.
            </h2>
            <p className="max-w-prose text-body-lg text-muted-foreground">
              Live prices and seat math are on our pricing page; these terms fix the payment
              mechanics, the partial-period rules, and the refund posture.
            </p>
          </div>

          <div className="flex flex-col gap-4 text-body-lg text-foreground">
            <p>
              Plans are billed monthly or annually in advance at the rate published on the{' '}
              <Link
                href="/pricing"
                className="font-medium text-foreground underline-offset-4 transition-colors hover:text-brand-500 hover:underline"
              >
                pricing page
              </Link>{' '}
              at the time of order. Mid-cycle plan upgrades are pro-rated for the remainder of the
              current billing period; downgrades take effect at the start of the next billing
              period.
            </p>
            <p>
              Fees are non-refundable except where required by law. We do not pro-rate refunds for
              partial months of annual plans; a workspace owner may cancel at any time and access
              continues until the end of the paid period.
            </p>
            <p>
              Overdue invoices may accrue interest at the rate of 1.5% per month (or the maximum
              rate permitted by law, whichever is lower) and may result in suspension of the
              workspace after written notice.
            </p>
          </div>
        </div>
      </section>

      {/* ===================== INTELLECTUAL PROPERTY ===================== */}
      <section
        aria-labelledby="ip-heading"
        className="border-t border-border bg-muted/30 section-lg scroll-mt-20"
      >
        <div className="container-page grid gap-10 lg:grid-cols-[1fr_1.6fr]">
          <div className="flex flex-col gap-3">
            <p className="text-eyebrow">4 · Intellectual property</p>
            <h2 id="ip-heading" className="font-display text-h1 tracking-tight text-foreground">
              Each side keeps what it brought.
            </h2>
            <p className="max-w-prose text-body-lg text-muted-foreground">
              {brand.name} owns the platform; you own your data and the findings generated from your
              assets. The clipping below is the operative clause.
            </p>
          </div>

          <Card className="border-border/80 bg-card">
            <CardHeader className="gap-2">
              <CardTitle className="font-display text-h3 tracking-tight text-foreground">
                Allocation of rights
              </CardTitle>
              <CardDescription className="text-body text-muted-foreground">
                The default IP allocation — Enterprise contracts may narrow or customise the grants
                in the Master Services Agreement.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <ul className="flex flex-col gap-3">
                {IP_BULLETS.map((b) => (
                  <li key={b} className="flex items-start gap-2.5 text-body text-foreground">
                    <span
                      aria-hidden
                      className="mt-2 size-1.5 shrink-0 rounded-full bg-brand-500"
                    />
                    <span className="text-body">{b}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* ===================== CONFIDENTIALITY ===================== */}
      <section
        aria-labelledby="confidentiality-heading"
        className="border-t border-border container-page section-lg scroll-mt-20"
      >
        <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr]">
          <div className="flex flex-col gap-3">
            <p className="text-eyebrow">5 · Confidentiality</p>
            <h2
              id="confidentiality-heading"
              className="font-display text-h1 tracking-tight text-foreground"
            >
              Each party protects the other&apos;s confidential information.
            </h2>
            <p className="max-w-prose text-body-lg text-muted-foreground">
              Confidential information includes any non-public technical, business, or product
              information disclosed by one party to the other in connection with the service. The
              receiving party will protect it with the same degree of care it uses for its own
              information of similar sensitivity, and not less than a commercially reasonable
              standard of care.
            </p>
          </div>

          <Card className="border-border/80 bg-card">
            <CardHeader className="gap-2">
              <CardTitle className="font-display text-h3 tracking-tight text-foreground">
                Carve-outs
              </CardTitle>
              <CardDescription className="text-body text-muted-foreground">
                Information that is not subject to confidentiality obligations.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <ul className="flex flex-col gap-3">
                {CONFIDENTIALITY_CARVE_OUTS.map((b) => (
                  <li key={b} className="flex items-start gap-2.5 text-body text-foreground">
                    <span
                      aria-hidden
                      className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/70"
                    />
                    <span className="text-body">{b}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* ===================== WARRANTIES & DISCLAIMER ===================== */}
      <section
        aria-labelledby="warranty-heading"
        className="border-t border-border bg-muted/30 section-lg scroll-mt-20"
      >
        <div className="container-page grid gap-10 lg:grid-cols-[1fr_1.6fr]">
          <div className="flex flex-col gap-3">
            <p className="text-eyebrow">6 · Warranties &amp; disclaimer</p>
            <h2
              id="warranty-heading"
              className="font-display text-h1 tracking-tight text-foreground"
            >
              The warranty is narrow; the disclaimer is broad.
            </h2>
            <p className="max-w-prose text-body-lg text-muted-foreground">
              We warrant that we operate the service with commercially reasonable skill and care;
              beyond that, the service is provided &quot;as is&quot; without other warranties — the
              standard SaaS disclaimer for explainability, fitness-for-purpose, and
              non-infringement.
            </p>
          </div>

          <Card className="lift border-border/80 bg-card">
            <CardContent className="flex flex-col gap-3 p-6 sm:p-8">
              <p className="text-body-lg text-foreground">
                Except for the express warranty above, the service is provided on an &quot;as
                is&quot; and &quot;as available&quot; basis, and to the maximum extent permitted by
                law, {brand.name} disclaims all other warranties, express or implied, including
                warranties of merchantability, fitness for a particular purpose, and
                non-infringement. We do not warrant that the service will be uninterrupted,
                error-free, or that every vulnerability will be detected.
              </p>
              <p className="text-small text-muted-foreground">
                Nothing in this section limits any warranty or condition that cannot be excluded
                under the applicable law of the customer&apos;s jurisdiction.
              </p>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* ===================== LIMITATION OF LIABILITY ===================== */}
      <section
        aria-labelledby="liability-heading"
        className="border-t border-border container-page section-lg scroll-mt-20"
      >
        <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr]">
          <div className="flex flex-col gap-3">
            <p className="text-eyebrow">7 · Limitation of liability</p>
            <h2
              id="liability-heading"
              className="font-display text-h1 tracking-tight text-foreground"
            >
              The cap and the exclusion.
            </h2>
            <p className="max-w-prose text-body-lg text-muted-foreground">
              The aggregate liability of each party is capped at the fees paid in the twelve months
              preceding the claim, with standard exclusions of indirect and consequential damages.
              The same formula appears on the privacy page.
            </p>
          </div>

          <Card className="lift relative flex flex-col border-brand-500/70 bg-card shadow-brand ring-1 ring-brand-500/40">
            <CardHeader className="gap-2">
              <span
                aria-hidden
                className="flex size-9 items-center justify-center rounded-[var(--radius)] bg-brand-500/15 text-brand-500"
              >
                <ShieldCheck className="size-5" aria-hidden />
              </span>
              <CardTitle className="font-display text-h3 tracking-tight text-foreground">
                Liability cap
              </CardTitle>
              <CardDescription className="text-body text-muted-foreground">
                The headline number — applied to both parties, symmetric in form.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <p className="text-body-lg text-foreground">
                Aggregate liability of either party under or in connection with these terms is
                capped at the fees paid or payable by the customer in the twelve (12) months
                immediately preceding the event giving rise to the claim. Neither party will be
                liable for indirect, incidental, special, consequential, or punitive damages,
                including loss of profits, revenue, customers, or data, even if advised of the
                possibility of such damages.
              </p>
              <p className="mt-3 text-small text-muted-foreground">
                The cap and exclusion do not apply to a party&apos;s indemnification obligations,
                breach of confidentiality, or gross negligence and wilful misconduct.
              </p>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* ===================== INDEMNIFICATION ===================== */}
      <section
        aria-labelledby="indemnification-heading"
        className="border-t border-border bg-muted/30 section-lg scroll-mt-20"
      >
        <div className="container-page grid gap-10 lg:grid-cols-[1fr_1.6fr]">
          <div className="flex flex-col gap-3">
            <p className="text-eyebrow">8 · Indemnification</p>
            <h2
              id="indemnification-heading"
              className="font-display text-h1 tracking-tight text-foreground"
            >
              Mutual IP indemnity, narrowed to documented use.
            </h2>
            <p className="max-w-prose text-body-lg text-muted-foreground">
              {brand.name} will defend the customer against any third-party claim that the platform,
              when used as documented, infringes a U.S. patent, copyright, or trademark, and pay
              damages awarded. The customer will defend us against claims arising from materials
              they uploaded or use of the platform outside the documentation.
            </p>
          </div>

          <div className="flex flex-col gap-4 text-body-lg text-foreground">
            <p>
              {`${brand.name}&apos;s`} indemnity is conditioned on prompt written notice of the
              claim, sole control of the defence and any settlement (provided we do not admit fault
              on your behalf), and reasonable cooperation. If we believe the platform may infringe,
              we may procure a licence, modify the platform, or terminate the affected workspace and
              refund pre-paid fees for the unused portion.
            </p>
            <p>
              The indemnity section is reciprocal and capped alongside the liability cap above.
              Open-source components incorporated into the platform remain licensed under their
              original terms.
            </p>
          </div>
        </div>
      </section>

      {/* ===================== TERMINATION ===================== */}
      <section
        aria-labelledby="termination-heading"
        className="border-t border-border container-page section-lg scroll-mt-20"
      >
        <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr]">
          <div className="flex flex-col gap-3">
            <p className="text-eyebrow">9 · Termination</p>
            <h2
              id="termination-heading"
              className="font-display text-h1 tracking-tight text-foreground"
            >
              Either side can end the relationship, on notice.
            </h2>
            <p className="max-w-prose text-body-lg text-muted-foreground">
              The customer may terminate at any time from workspace settings. Either party may
              terminate for material breach with thirty (30) days&apos; written notice if the breach
              is not cured within that window.
            </p>
          </div>

          <div className="flex flex-col gap-4 text-body-lg text-foreground">
            <p>
              On termination, access to the workspace ceases at the end of the paid period (or
              immediately for cause). We will export the workspace contents as a single tarball
              (assets, findings, audit trail, reports) within fourteen (14) days of termination
              effective date, after which we run a hard purge of the live database and in-region
              backups and emit a signed deletion receipt.
            </p>
            <p>
              Sections that by their nature should survive termination — confidentiality,
              intellectual property allocation, the liability cap, and governing law — survive
              termination of these terms.
            </p>
          </div>
        </div>
      </section>

      {/* ===================== GOVERNING LAW ===================== */}
      <section
        aria-labelledby="governing-law-heading"
        className="border-t border-border bg-muted/30 section-lg scroll-mt-20"
      >
        <div className="container-page grid gap-10 lg:grid-cols-[1fr_1.6fr]">
          <div className="flex flex-col gap-3">
            <p className="text-eyebrow">10 · Governing law &amp; disputes</p>
            <h2
              id="governing-law-heading"
              className="font-display text-h1 tracking-tight text-foreground"
            >
              Delaware governs; the courts of New Castle County hear it.
            </h2>
            <p className="max-w-prose text-body-lg text-muted-foreground">
              These terms are governed by Delaware law. Disputes are heard in the state and federal
              courts of New Castle County, Delaware, with an arbitration opt-in on Enterprise plans.
            </p>
          </div>

          <div className="flex flex-col gap-4 text-body-lg text-foreground">
            <p>
              These terms are governed by the laws of the State of Delaware, USA, without regard to
              its conflict-of-laws principles. The state and federal courts located in New Castle
              County, Delaware have exclusive jurisdiction, except that either party may apply to a
              court of competent jurisdiction for interim or injunctive relief.
            </p>
            <p>
              Enterprise customers may opt-in to binding arbitration under the AAA Commercial
              Arbitration Rules by mutual written agreement. The arbitration seat will be New Castle
              County, Delaware, the language English, and the award enforceable in any court of
              competent jurisdiction.
            </p>
          </div>
        </div>
      </section>

      {/* ===================== CHANGES TO TERMS ===================== */}
      <section
        aria-labelledby="changes-heading"
        className="border-t border-border container-page section-lg scroll-mt-20"
      >
        <div className="flex max-w-prose flex-col gap-3">
          <p className="text-eyebrow">11 · Changes to these terms</p>
          <h2 id="changes-heading" className="font-display text-h1 tracking-tight text-foreground">
            We will give you thirty days&apos; notice before anything changes.
          </h2>
          <p className="text-body-lg text-muted-foreground">
            Terms change. We will give at least thirty (30) days&apos; notice of a change by email
            to the workspace owner and by an in-product banner before the change takes effect.
            Continued use of the service after the effective date constitutes acceptance of the
            updated terms. Material adverse changes — to the liability cap, governing law, or
            data-handling commitments — will not be applied retroactively.
          </p>
          <p className="text-body text-muted-foreground">
            If a change is not acceptable, the workspace owner may terminate the agreement before
            the effective date and receive a pro-rated refund of pre-paid fees for the unused
            portion of the term.
          </p>
        </div>
      </section>

      {/* ===================== CONTACT STRIP ===================== */}
      <section
        aria-labelledby="terms-cta-heading"
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
                <Scale className="size-3.5 text-brand-500" aria-hidden />
                <span>Questions about the contract</span>
              </p>
              <h2
                id="terms-cta-heading"
                className="font-display text-h2 tracking-tight text-foreground"
              >
                A redline, an MSA, or a procurement redline — same inbox.
              </h2>
              <p className="text-body text-muted-foreground">
                Procurement, legal, and security teams can reach the contracts team at this address.
                We countersign within one business day for straightforward redlines.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button asChild className="shadow-brand">
                <a
                  href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`${brand.name} - terms / contract question`)}`}
                >
                  Email contracts team
                </a>
              </Button>
              <Button asChild variant="outline">
                <Link href="/security">See security &amp; compliance</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Structured data: WebPage + BreadcrumbList so search engines can read
          the page identity and the path Home → Terms. JSON.stringify output
          only contains characters safe to live inside a <script> tag body. */}
      <script type="application/ld+json">{JSON.stringify(TERMS_WEBPAGE_LD)}</script>
      <script type="application/ld+json">{JSON.stringify(TERMS_BREADCRUMB_LD)}</script>
    </main>
  );
}
