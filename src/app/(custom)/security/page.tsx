// @polsia:user-owned — public /security trust page. Server Component so it
// can export per-page metadata. Copy is constant; no data fetch, no auth gate.

import { Database, FileLock2, GlobeLock, Layers, LifeBuoy, ShieldCheck } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ComponentType } from 'react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { brand } from '@/lib/brand';

export const metadata: Metadata = {
  title: 'Security',
  description: `How ${brand.name} protects vulnerability scanner data at rest and in transit — residency, AES-256 encryption, per-workspace isolation, retention windows, and our SOC 2 + GDPR / SCC compliance roadmap.`,
  alternates: { canonical: '/security' },
  openGraph: {
    title: `Security · ${brand.name}`,
    description:
      'Data residency, encryption, per-workspace isolation, retention windows and SOC 2 readiness for the enterprise vulnerability scanner.',
    url: '/security',
  },
};

const CONTACT_EMAIL = brand.contactEmail;

interface SecurityPillar {
  key: string;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: string;
  body: string;
  bullets: string[];
}

const SECURITY_PILLARS: SecurityPillar[] = [
  {
    key: 'residency',
    icon: GlobeLock,
    title: 'Data residency',
    body: 'Scan runs execute in the region your workspace is pinned to. EU workspaces stay in EU regions end-to-end; US workspaces land in us-east. We never replicate findings across regions without an explicit migration request from a workspace admin.',
    bullets: [
      'Region pinning at workspace creation — selectable on every paid plan.',
      'EU customers: assets, findings and audit trails stay in eu-central-1.',
      'Data sovereignty commitments are written into the Enterprise MSA.',
    ],
  },
  {
    key: 'encryption',
    icon: ShieldCheck,
    title: 'Encryption at rest & in transit',
    body: 'Scan traffic is TLS 1.2+ on the wire with modern cipher suites; data at rest lives under envelope-encrypted AES-256-GCM in our managed Postgres plus R2 object store. Envelope keys rotate on a documented cadence and are never co-located with the workloads they unlock.',
    bullets: [
      'TLS 1.2+ in transit — HSTS preload, TLS 1.3 preferred where peers support it.',
      'AES-256-GCM at rest; envelope encryption separates data and key lifecycles.',
      'Quarterly key-rotation cadence, audited under our change-management policy.',
    ],
  },
  {
    key: 'isolation',
    icon: Layers,
    title: 'Per-workspace isolation',
    body: 'Every workspace is its own tenant: data, RBAC role bindings, API tokens, and the audit log that traces them are partitioned per workspace. The engine cannot fan a query from one workspace into another — there is no shared cross-workspace index, no shared scanner job, and no shared cache row that crosses the boundary.',
    bullets: [
      'Tenant boundaries enforced in the data layer, not just at the API gateway.',
      'RBAC roles (Owner / Admin / Analyst / Read-only) are scoped per workspace.',
      'Audit logs are separated per workspace — exports never cross-join tenants.',
    ],
  },
  {
    key: 'retention',
    icon: FileLock2,
    title: 'Retention windows',
    body: 'Active data is retained for the life of the workspace plus a configurable deletion SLA on cancellation. Backups are retained on a rolling 35-day window and live in the same region as the live database. On workspace deletion we run a hard purge and emit a signed deletion receipt your security team can attach to your ticket.',
    bullets: [
      'Active retention: workspace lifetime, with auto-archive after 90 days idle.',
      'Backup retention: rolling 35 days in-region, encrypted under the same KMS.',
      'Configurable deletion SLA on Enterprise; one-tarball export on exit.',
    ],
  },
  {
    key: 'compliance',
    icon: ShieldCheck,
    title: 'Compliance roadmap',
    body: 'SOC 2 Type II readiness is the active track — controls for access management, change management, vendor risk, and incident response are already in place; we are collecting the audit evidence window now with a target attestation in the coming quarters. GDPR posture with SCCs, plus an active ISO 27001 track for late next year.',
    bullets: [
      'SOC 2 readiness — vulnerability scanner is already operating under the controls.',
      'GDPR + SCCs signed as standard — DPA flows through checkout on request.',
      'ISO 27001 planned — gap assessment underway as part of the SOC 2 programme.',
    ],
  },
];

const SUBPROCESSORS: { name: string; purpose: string; region: string }[] = [
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
];

const SECURITY_FAQS = [
  {
    q: 'Where does my scan data live?',
    a: 'Scan data is stored in the region your workspace is pinned to at creation — EU workspaces in eu-central, US workspaces in us-east. We never replicate findings across regions without an explicit migration request from a workspace admin, and the data sovereignty commitments are written into the Enterprise MSA.',
  },
  {
    q: 'How is scan traffic encrypted in transit?',
    a: 'All scan traffic is TLS 1.2+ on the wire with HSTS preload enabled. We prefer TLS 1.3 with modern AEAD cipher suites where the peer supports them. Agent-to-control-plane traffic uses mutual auth tokens that rotate on the same quarterly cadence as our other secrets.',
  },
  {
    q: 'Can a workspace ever see another workspace’s findings?',
    a: 'No. Every workspace is its own tenant boundary enforced in the data layer, not only at the API gateway. RBAC roles are scoped per workspace; the scanner engine has no shared cross-workspace index or cache row that would let one tenant read another. Audit logs are partitioned the same way.',
  },
  {
    q: 'What happens to my data when I cancel?',
    a: 'On cancellation, your workspace exports as a single tarball (assets, findings, audit trail, SBOMs, reports) and we run a hard purge of the live database plus all in-region backups. We emit a signed deletion receipt you can attach to your internal ticket. Enterprise contracts can specify a longer retention window on request.',
  },
  {
    q: 'Are you SOC 2 certified yet?',
    a: 'SOC 2 Type II readiness is the active track — the controls for access management, change management, vendor risk and incident response are already running in production. We are collecting the audit evidence window now with a target attestation in the coming quarters. ISO 27001 is on the same programme, planned later.',
  },
  {
    q: 'Do you sign DPAs / SCCs?',
    a: 'Yes. GDPR posture plus Standard Contractual Clauses are signed as standard on request — the DPA flows through checkout for self-serve plans and is part of the MSA on Enterprise. We will also counter-sign CCPA addenda and most regional data-protection addenda for qualified customers.',
  },
];

const FAQ_JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: SECURITY_FAQS.map((f) => ({
    '@type': 'Question',
    name: f.q,
    acceptedAnswer: { '@type': 'Answer', text: f.a },
  })),
};

export default function SecurityPage() {
  return (
    <main className="relative">
      {/* ===================== HERO ===================== */}
      <section
        aria-labelledby="security-heading"
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
            <pattern id="security-grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="currentColor" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#security-grid)" />
        </svg>

        <div className="container-page grid gap-6 pb-section-lg pt-section-lg lg:grid-cols-[1.1fr_0.9fr] lg:items-end lg:gap-12">
          <div className="flex flex-col gap-5">
            <p className="text-eyebrow">Security &amp; compliance</p>
            <h1
              id="security-heading"
              className="font-display text-display tracking-tight text-foreground"
            >
              The data-handling story{' '}
              <span className="block text-brand-500">procurement asks first.</span>
            </h1>
            <p className="max-w-xl text-body-lg text-muted-foreground">
              {`Every ${brand.name} vulnerability scanner workspace is region-pinned,
              encrypted at rest and in transit, isolated at the data layer, and
              operated under the controls we are running SOC 2 readiness against.
              Below is what we tell enterprise security teams on day one — and the
              paperwork we will sign before they sign.`}
            </p>
          </div>

          <dl className="grid grid-cols-3 gap-x-4 gap-y-1 rounded-[var(--radius-lg)] border border-border bg-card/60 p-5 shadow-sm backdrop-blur-sm">
            <div className="flex flex-col">
              <dt className="text-caption uppercase tracking-wider text-muted-foreground/80">
                Residency
              </dt>
              <dd className="font-display text-h4 text-foreground">EU / US</dd>
              <dd className="text-small text-muted-foreground">Region pinned</dd>
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
                Isolation
              </dt>
              <dd className="font-display text-h4 text-foreground">Per workspace</dd>
              <dd className="text-small text-muted-foreground">Data-layer boundary</dd>
            </div>
          </dl>
        </div>
      </section>

      {/* ===================== POSTURE GRID ===================== */}
      <section aria-labelledby="posture-heading" className="container-page section-lg scroll-mt-20">
        <div className="flex max-w-prose flex-col gap-3">
          <p className="text-eyebrow">Posture</p>
          <h2 id="posture-heading" className="font-display text-h1 tracking-tight text-foreground">
            Five controls every security questionnaire asks about — answered.
          </h2>
          <p className="text-body-lg text-muted-foreground">
            The five cards below mirror the order of the security review we run for new enterprise
            customers. Each one cites the policy + the implementation; the long-form version lives
            in our trust portal.
          </p>
        </div>

        <div className="mt-10 grid gap-6 md:grid-cols-2">
          {SECURITY_PILLARS.map((pillar, idx) => {
            const isCompliance = pillar.key === 'compliance';
            const Icon = pillar.icon;
            return (
              <Card
                key={pillar.key}
                className={
                  isCompliance
                    ? 'lift relative flex flex-col border-brand-500/70 bg-card shadow-brand ring-1 ring-brand-500/40'
                    : 'lift relative flex flex-col border-border/80 bg-card'
                }
              >
                <CardHeader className="gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <span
                      aria-hidden
                      className={
                        isCompliance
                          ? 'flex size-9 items-center justify-center rounded-[var(--radius)] bg-brand-500/15 text-brand-500'
                          : 'flex size-9 items-center justify-center rounded-[var(--radius)] bg-muted text-foreground'
                      }
                    >
                      <Icon className="size-5" aria-hidden />
                    </span>
                    {isCompliance ? (
                      <Badge className="rounded-full px-2.5 py-1 shadow-sm">On the roadmap</Badge>
                    ) : (
                      <span className="text-eyebrow">0{idx + 1}</span>
                    )}
                  </div>
                  <CardTitle className="font-display text-h3 tracking-tight text-foreground">
                    {pillar.title}
                  </CardTitle>
                  <CardDescription className="text-body text-muted-foreground">
                    {pillar.body}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 pt-0">
                  <ul className="flex flex-col gap-2">
                    {pillar.bullets.map((b) => (
                      <li key={b} className="flex items-start gap-2.5 text-body text-foreground">
                        <span
                          aria-hidden
                          className={
                            isCompliance
                              ? 'mt-2 size-1.5 shrink-0 rounded-full bg-brand-500'
                              : 'mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/70'
                          }
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

      {/* ===================== SUBPROCESSORS ===================== */}
      <section
        aria-labelledby="subprocessors-heading"
        className="border-t border-border bg-muted/30 section-lg scroll-mt-20"
      >
        <div className="container-page grid gap-10 lg:grid-cols-[1fr_1.4fr]">
          <div className="flex flex-col gap-3">
            <p className="text-eyebrow">Subprocessors &amp; data flow</p>
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
                {SUBPROCESSORS.map((p) => (
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

      {/* ===================== FAQ ===================== */}
      <section
        id="faq"
        aria-labelledby="security-faq-heading"
        className="border-t border-border bg-muted/30 section-lg scroll-mt-20"
      >
        <div className="container-page grid gap-10 lg:grid-cols-[1fr_1.6fr]">
          <div>
            <p className="text-eyebrow">Security FAQ</p>
            <h2
              id="security-faq-heading"
              className="mt-3 font-display text-h1 tracking-tight text-foreground"
            >
              The questions security teams ask before they sign.
            </h2>
            <p className="mt-4 max-w-prose text-body text-muted-foreground">
              If procurement, security or legal needs something more than what&apos;s here, write to{' '}
              <a
                href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(brand.name)}%20-%20security%20questionnaire`}
                className="font-medium text-foreground underline-offset-4 transition-colors hover:text-brand-500 hover:underline"
              >
                {CONTACT_EMAIL}
              </a>{' '}
              and a named human on our security team will respond within one business day.
            </p>
          </div>

          <Accordion
            type="single"
            collapsible
            className="rounded-[var(--radius-lg)] border border-border bg-card px-2 shadow-sm"
          >
            {SECURITY_FAQS.map((f, i) => (
              <AccordionItem
                key={f.q}
                value={`security-faq-${i}`}
                className={i === SECURITY_FAQS.length - 1 ? 'border-b-0' : ''}
              >
                <AccordionTrigger className="px-4 font-display text-body-lg text-foreground">
                  {f.q}
                </AccordionTrigger>
                <AccordionContent className="px-4 text-body text-muted-foreground">
                  {f.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>

      {/* ===================== TRUST CTA ===================== */}
      <section
        aria-labelledby="trust-cta-heading"
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
                <LifeBuoy className="size-3.5 text-brand-500" aria-hidden />
                <span>Security review</span>
              </p>
              <h2
                id="trust-cta-heading"
                className="font-display text-h2 tracking-tight text-foreground"
              >
                Send us your questionnaire — we&apos;ll come back inside one business day.
              </h2>
              <p className="text-body text-muted-foreground">
                CAIQ, SIG Lite, your own DPA, the long-form SOC 2 readiness packet, or just the
                controls evidence — we will route the right person for whichever document you need.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button asChild className="shadow-brand">
                <a
                  href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(brand.name)}%20-%20security%20questionnaire`}
                >
                  Email security team
                </a>
              </Button>
              <Button asChild variant="outline">
                <Link href="/signup?tier=enterprise&trial=1">Start a scoped pilot</Link>
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
