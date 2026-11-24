// @polsia:user-owned — public /privacy route. Server Component so it can
// export per-page metadata. Copy is constant; no data fetch, no auth gate.

import { Database, ShieldCheck, User } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ComponentType } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { brand } from '@/lib/brand';

export const metadata: Metadata = {
  title: 'Privacy',
  description: `How ${brand.name} collects, uses, retains, and shares scanner data — subprocessor inventory, region pinning, the legal bases, your rights, and how to reach the privacy team.`,
  alternates: { canonical: '/privacy' },
  openGraph: {
    title: `Privacy · ${brand.name}`,
    description:
      'How VulnAware collects, uses, retains, and shares vulnerability scanner data — subprocessor inventory, region pinning, your rights, and a contact line to the privacy team.',
    url: '/privacy',
  },
};

const CONTACT_EMAIL = brand.contactEmail;

interface DataCategoryCard {
  key: string;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: string;
  body: string;
  bullets: string[];
}

const DATA_COLLECTED: DataCategoryCard[] = [
  {
    key: 'account',
    icon: User,
    title: 'Account data',
    body: 'Information you give us when you sign up and operate a workspace. We use it to provision your tenant, bill you, and reach you about service changes.',
    bullets: [
      'Email address, name, and workspace name at signup.',
      'Billing contact, tax identifier, and invoice recipient on paid plans.',
      'Authentication credentials under your control — via OAuth, passkey, or password + bcrypt.',
    ],
  },
  {
    key: 'workspace',
    icon: Database,
    title: 'Workspace data',
    body: 'The configurations, assets, and integration credentials you load into a workspace. Workspaces are isolated at the data layer; we never read across tenants.',
    bullets: [
      'Asset inventories — domains, hosts, repos, and cloud identifiers you authorise us to scan.',
      'API keys and IAM roles you store, encrypted under a per-workspace KMS key.',
      'Notification destinations, alert routing, and audit log entries.',
    ],
  },
  {
    key: 'scan-telemetry',
    icon: ShieldCheck,
    title: 'Scan telemetry',
    body: 'What our scanner observes about your external surface during a run — findings, signal traces, rate-limit headers, and timing metadata. Stored in the region your workspace is pinned to.',
    bullets: [
      'CVE and configuration findings ranked against your real asset context.',
      'Request and response traces for findings — used for remediation runs, never replayed elsewhere.',
      'Upload sizes, scan duration, and rate-limit telemetry for capacity planning.',
    ],
  },
];

const USE_BULLETS = [
  'Operate the service — run your scans, deliver findings, route alerts to your destinations.',
  'Secure the workspace — enforce RBAC, throttle abusive callers, detect credential misuse.',
  'Generate findings — score CVEs against your asset context, write remediation payloads.',
  'Send transactional alerts — incident notifications, scan completion, account-safety messages.',
  'Comply with the law — maintain audit trails, respond to lawful disclosure requests within the legal window.',
];

const USER_OBLIGATIONS = [
  'Do not direct scans at systems you do not own or operate, or that your engagement scope does not cover.',
  'Do not reverse-engineer, decompile, or extract the proprietary scoring model or remediation engine.',
  'Do not republish findings for assets you do not own — pipeline output is per-workspace, not a public leaderboard.',
  'Do not use the platform to violate any computer-misuse, export-control, or sanctions law in the jurisdictions you operate from.',
];

const PRIVACY_WEBPAGE_LD = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: `Privacy · ${brand.name}`,
  url: '/privacy',
  description: `How ${brand.name} handles vulnerability scanner data — collection, use, retention, subprocessors, your rights, and a contact line to the privacy team.`,
};

const PRIVACY_BREADCRUMB_LD = {
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
      name: 'Privacy',
      item: '/privacy',
    },
  ],
};

export default function PrivacyPage() {
  return (
    <main className="relative">
      {/* ===================== HERO ===================== */}
      <section
        aria-labelledby="privacy-hero-heading"
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
            <pattern id="privacy-grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="currentColor" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#privacy-grid)" />
        </svg>

        <div className="container-page grid gap-6 pb-section-lg pt-section-lg lg:grid-cols-[1.1fr_0.9fr] lg:items-end lg:gap-12">
          <div className="flex flex-col gap-5">
            <p className="text-eyebrow inline-flex items-center gap-2">
              <span aria-hidden className="size-1.5 rounded-full bg-brand-500" />
              <span>Privacy</span>
            </p>
            <h1
              id="privacy-hero-heading"
              className="font-display text-display tracking-tight text-foreground"
            >
              What we collect, why, and{' '}
              <span className="block text-brand-500">what we never touch.</span>
            </h1>
            <p className="max-w-xl text-body-lg text-muted-foreground">
              {`${brand.name} runs an autonomous vulnerability scanner. The page below
              spells out what data the scanner observes, how we use it, who we share it
              with, and how you reach us to ask questions, request exports, or invoke
              any of the rights your jurisdiction gives you.`}
            </p>
          </div>

          <dl className="grid grid-cols-3 gap-x-4 gap-y-1 rounded-[var(--radius-lg)] border border-border bg-card/60 p-5 shadow-sm backdrop-blur-sm">
            <div className="flex flex-col">
              <dt className="text-caption uppercase tracking-wider text-muted-foreground/80">
                Residency
              </dt>
              <dd className="font-display text-h4 text-foreground">EU / US</dd>
              <dd className="text-small text-muted-foreground">Pinned per workspace</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-caption uppercase tracking-wider text-muted-foreground/80">
                Encryption
              </dt>
              <dd className="font-display text-h4 text-foreground">AES-256</dd>
              <dd className="text-small text-muted-foreground">At rest + TLS 1.2+</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-caption uppercase tracking-wider text-muted-foreground/80">
                Marketing
              </dt>
              <dd className="font-display text-h4 text-foreground">Never</dd>
              <dd className="text-small text-muted-foreground">No list selling</dd>
            </div>
          </dl>
        </div>
      </section>

      {/* ===================== DATA WE COLLECT ===================== */}
      <section
        aria-labelledby="data-collected-heading"
        className="container-page section-lg scroll-mt-20"
      >
        <div className="flex max-w-prose flex-col gap-3">
          <p className="text-eyebrow">Data we collect</p>
          <h2
            id="data-collected-heading"
            className="font-display text-h1 tracking-tight text-foreground"
          >
            Three buckets, each with a stated purpose.
          </h2>
          <p className="text-body-lg text-muted-foreground">
            Everything we hold falls into one of the categories below. If a piece of data does not
            fit one of them, we either do not collect it or we collect it in a de-identified form
            for engineering telemetry.
          </p>
        </div>

        <div className="mt-10 grid gap-6 md:grid-cols-2">
          {DATA_COLLECTED.map((cat) => {
            const Icon = cat.icon;
            return (
              <Card key={cat.key} className="lift flex flex-col border-border/80 bg-card">
                <CardHeader className="gap-3">
                  <span
                    aria-hidden
                    className="flex size-9 items-center justify-center rounded-[var(--radius)] bg-muted text-foreground"
                  >
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <CardTitle className="font-display text-h3 tracking-tight text-foreground">
                    {cat.title}
                  </CardTitle>
                  <CardDescription className="text-body text-muted-foreground">
                    {cat.body}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 pt-0">
                  <ul className="flex flex-col gap-2">
                    {cat.bullets.map((b) => (
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
            );
          })}
        </div>
      </section>

      {/* ===================== HOW WE USE IT ===================== */}
      <section
        aria-labelledby="how-we-use-heading"
        className="border-t border-border bg-muted/30 section-lg scroll-mt-20"
      >
        <div className="container-page grid gap-10 lg:grid-cols-[1fr_1.6fr]">
          <div className="flex flex-col gap-3">
            <p className="text-eyebrow">How we use it</p>
            <h2
              id="how-we-use-heading"
              className="font-display text-h1 tracking-tight text-foreground"
            >
              Five purposes, no other.
            </h2>
            <p className="max-w-prose text-body-lg text-muted-foreground">
              Every byte of scanner data falls under one of the purposes below. We do not enrich,
              sell, rent, or third-party-share any of it — and we will publish a change-log entry
              before we ever do.
            </p>
          </div>

          <Card className="border-border/80 bg-card">
            <CardHeader className="gap-2">
              <CardTitle className="font-display text-h3 tracking-tight text-foreground">
                Purposes of processing
              </CardTitle>
              <CardDescription className="text-body text-muted-foreground">
                The exhaustive list — anything we do with your data lands here.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <ul className="flex flex-col gap-3">
                {USE_BULLETS.map((b) => (
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

      {/* ===================== SUBPROCESSORS ===================== */}
      <section
        id="subprocessors"
        aria-labelledby="subprocessors-heading"
        className="border-t border-border section-lg scroll-mt-20"
      >
        <div className="container-page grid gap-10 lg:grid-cols-[1fr_1.4fr]">
          <div className="flex flex-col gap-3">
            <p className="text-eyebrow">Subprocessors</p>
            <h2
              id="subprocessors-heading"
              className="font-display text-h2 tracking-tight text-foreground"
            >
              Who touches your data, and where it lives.
            </h2>
            <p className="max-w-prose text-body text-muted-foreground">
              Every named subprocessor is listed in the DPA you sign with us. The list below is the
              live inventory — we publish change-log entries whenever a subprocessor is added or
              removed, and we give customers 30 days&apos; notice on changes that affect active
              processing.
            </p>
            <p className="max-w-prose text-body text-muted-foreground">
              The full subprocessor inventory, processing regions, and the change-log history also
              live on the{' '}
              <Link
                href="/security#subprocessors"
                className="font-medium text-foreground underline-offset-4 transition-colors hover:text-brand-500 hover:underline"
              >
                Security &amp; compliance
              </Link>{' '}
              page.
            </p>
          </div>

          <Card className="border-border/80 bg-card">
            <CardHeader className="gap-2">
              <span
                aria-hidden
                className="flex size-9 items-center justify-center rounded-[var(--radius)] bg-muted text-foreground"
              >
                <Database className="size-5" aria-hidden />
              </span>
              <CardTitle className="font-display text-h3 tracking-tight text-foreground">
                Subprocessor inventory
              </CardTitle>
              <CardDescription className="text-body text-muted-foreground">
                Five vendors in scope today. Regions are pinned per workspace at creation;
                cross-region replication never happens silently.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <ul className="divide-y divide-border/70">
                {[
                  {
                    name: 'Cloudflare',
                    purpose: 'CDN, edge cache, R2 object store for scan artefacts',
                    region: 'Global (per-resolver)',
                  },
                  {
                    name: 'Render',
                    purpose: 'Application runtime + managed Postgres',
                    region: 'us-east / eu-central',
                  },
                  {
                    name: 'PostgreSQL (managed by Render)',
                    purpose: 'Primary datastore for findings, assets, audit',
                    region: 'Pinned per workspace',
                  },
                  {
                    name: 'Polsia AI proxy',
                    purpose: 'Embedding + AI features for the scanner',
                    region: 'us-east',
                  },
                  {
                    name: 'Polsia email proxy',
                    purpose: 'Transactional email (alerts, invitations)',
                    region: 'Global',
                  },
                ].map((p) => (
                  <li
                    key={p.name}
                    className="grid grid-cols-[1.4fr_1.6fr_1fr] gap-4 py-3 text-body"
                  >
                    <span className="font-medium text-foreground">{p.name}</span>
                    <span className="text-muted-foreground">{p.purpose}</span>
                    <span className="text-small text-muted-foreground sm:text-right">
                      {p.region}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* ===================== USER OBLIGATIONS ===================== */}
      <section
        aria-labelledby="obligations-heading"
        className="border-t border-border container-page section-lg scroll-mt-20"
      >
        <div className="grid gap-10 lg:grid-cols-[1fr_1.4fr]">
          <div className="flex flex-col gap-3">
            <p className="text-eyebrow">Your obligations</p>
            <h2
              id="obligations-heading"
              className="font-display text-h1 tracking-tight text-foreground"
            >
              Use the scanner the way it&apos;s designed to be used.
            </h2>
            <p className="max-w-prose text-body-lg text-muted-foreground">
              The service is a defensive scanning tool. The list below is short on purpose — the
              things we will not ship as a finding, the things we will not run as a scan, and the
              uses we will not support.
            </p>
          </div>

          <Card className="border-border/80 bg-card">
            <CardHeader className="gap-2">
              <Badge variant="outline" className="w-fit rounded-full font-normal">
                Prohibited uses
              </Badge>
              <CardTitle className="font-display text-h3 tracking-tight text-foreground">
                What running the scanner will not let you do.
              </CardTitle>
              <CardDescription className="text-body text-muted-foreground">
                Breach of these obligations is grounds for suspension and termination of the
                workspace under the Master Services Agreement.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <ul className="flex flex-col gap-3">
                {USER_OBLIGATIONS.map((b) => (
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

      {/* ===================== LIABILITY CAP ===================== */}
      <section
        aria-labelledby="liability-cap-heading"
        className="border-t border-border bg-muted/30 container-page section-lg scroll-mt-20"
      >
        <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr]">
          <div className="flex flex-col gap-3">
            <p className="text-eyebrow">Liability cap</p>
            <h2
              id="liability-cap-heading"
              className="font-display text-h1 tracking-tight text-foreground"
            >
              Liability is bounded to a familiar formula.
            </h2>
            <p className="max-w-prose text-body-lg text-muted-foreground">
              The aggregate liability of {brand.name} under the Master Services Agreement is capped
              — we&apos;ve kept the formula the same as the comparable clauses in our other
              enterprise contracts so legal teams are not negotiating from a blank page.
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <p className="text-body-lg text-foreground">
              Aggregate liability under the Master Services Agreement is capped at the fees paid by
              the customer in the twelve (12) months immediately preceding the event giving rise to
              the claim. Indirect, incidental, special, consequential, and punitive damages are
              excluded to the maximum extent permitted by applicable law. The cap and exclusions do
              not apply to a party&apos;s indemnification obligations, breach of confidentiality, or
              gross negligence and wilful misconduct.
            </p>
            <p className="text-small text-muted-foreground">
              Self-serve plans (Starter, Pro, Team) inherit the same cap from the click-through
              terms at signup. Enterprise plans may negotiate a higher cap tied to the contract
              value.
            </p>
          </div>
        </div>
      </section>

      {/* ===================== GOVERNING LAW + DPA ===================== */}
      <section
        aria-labelledby="governing-law-heading"
        className="border-t border-border container-page section-lg scroll-mt-20"
      >
        <div className="flex max-w-prose flex-col gap-3">
          <p className="text-eyebrow">Governing law &amp; data processing</p>
          <h2
            id="governing-law-heading"
            className="font-display text-h1 tracking-tight text-foreground"
          >
            Venue, arbitration, and the DPA you can request on demand.
          </h2>
          <p className="text-body-lg text-muted-foreground">
            We have kept the choice-of-law clause central so legal teams do not have to fork time on
            negotiation. The full governing-law block:
          </p>
        </div>

        <div className="mt-8 flex flex-col gap-4 text-body-lg text-foreground">
          <p>
            These terms and any non-contractual obligations arising out of or in connection with
            them are governed by, and construed in accordance with, the laws of the State of
            Delaware, USA, without regard to its conflict-of-laws principles.
          </p>
          <p>
            The state and federal courts located in New Castle County, Delaware have exclusive
            jurisdiction to settle any dispute or claim arising out of or in connection with these
            terms, except that either party may apply to a court of competent jurisdiction for
            interim or injunctive relief.
          </p>
          <p>
            Enterprise customers may opt-in to binding arbitration under the AAA Commercial
            Arbitration Rules by mutual written agreement. Self-serve plans retain the court venue
            as the default dispute-resolution channel.
          </p>
          <p>
            Our Data Processing Addendum, which incorporates the EU Standard Contractual Clauses
            (Module 2: controller-to-processor) and a CCPA service-provider addendum, is available
            on request via{' '}
            <a
              href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`${brand.name} - DPA request`)}`}
              className="font-medium text-foreground underline-offset-4 transition-colors hover:text-brand-500 hover:underline"
            >
              {CONTACT_EMAIL}
            </a>{' '}
            and forms part of the Master Services Agreement on Enterprise plans.
          </p>
        </div>
      </section>

      {/* ===================== CONTACT STRIP ===================== */}
      <section
        aria-labelledby="privacy-cta-heading"
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
                <span aria-hidden className="size-1.5 rounded-full bg-brand-500" />
                <span>Privacy questions</span>
              </p>
              <h2
                id="privacy-cta-heading"
                className="font-display text-h2 tracking-tight text-foreground"
              >
                Data access, deletion, DPA, or a formal privacy review.
              </h2>
              <p className="text-body text-muted-foreground">
                Email the privacy team or open the contact form — the request lands on the same
                inbox the DPA paperwork and the export/deletion queue are read from.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button asChild className="shadow-brand">
                <a
                  href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`${brand.name} - privacy request`)}`}
                >
                  Email privacy team
                </a>
              </Button>
              <Button asChild variant="outline">
                <Link href="/contact">Use the contact form</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Structured data: WebPage + BreadcrumbList so search engines can read
          the page identity and the path Home → Privacy. JSON.stringify output
          only contains characters safe to live inside a <script> tag body. */}
      <script type="application/ld+json">{JSON.stringify(PRIVACY_WEBPAGE_LD)}</script>
      <script type="application/ld+json">{JSON.stringify(PRIVACY_BREADCRUMB_LD)}</script>
    </main>
  );
}
