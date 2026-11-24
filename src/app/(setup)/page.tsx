// @polsia:user-owned — home / landing page.

import type { Metadata } from 'next';
import Link from 'next/link';
import { LivePulse } from '@/components/custom/live-pulse';
import { TrialCta } from '@/components/custom/trial/trial-cta';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { brand } from '@/lib/brand';
import { siteDescription, siteName } from '@/lib/site';

// Keep this a Server Component so it can export metadata.
export const metadata: Metadata = {
  title: { absolute: siteName },
  description: siteDescription,
  // Do not export an explicit openGraph object here; that suppresses the
  // file-based opengraph-image.tsx for the home route.
  alternates: { canonical: '/' },
};

const CONTACT_EMAIL = brand.contactEmail;

const CAPABILITIES = [
  {
    index: '01',
    area: 'External surface',
    title: 'Continuous internet-wide exposure monitoring',
    body: 'A continuously running discovery loop profiles your domains, subdomains, certificates, and exposed services—cataloguing every reachable asset the way an attacker would.',
  },
  {
    index: '02',
    area: 'Internal network',
    title: 'Authenticated internal scanning at protocol depth',
    body: 'Agentless and credentialed scans reach across VLANs and cloud networks, mapping misconfigurations, weak protocols, lateral-movement paths, and unpatched firmware.',
  },
  {
    index: '03',
    area: 'Cloud & SaaS',
    title: 'Cloud posture, IAM drift, and SaaS misconfig',
    body: 'Cross-account posture review against CIS benchmarks; identity, network, and data-plane drift detection across AWS, Azure, GCP, and the SaaS stack your teams rely on.',
  },
  {
    index: '04',
    area: 'Software supply',
    title: 'SCA + SBOM for the dependency graph you ship',
    body: 'Direct, transitive, and developer-introduced dependencies are tracked against CVE feeds and advisories, with SBOM export for ingestion into downstream gates.',
  },
  {
    index: '05',
    area: 'Application layer',
    title: 'DAST + targeted dynamic testing for live services',
    body: 'Crawl-and-fuzz the running app surface for injection, auth, and business-logic classes—tuned to the framework and stack so findings map to real exploitability.',
  },
  {
    index: '06',
    area: 'Compliance',
    title: 'SOC 2, ISO 27001, HIPAA, PCI evidence on demand',
    body: 'Findings roll up into framework-mapped controls with the audit trail intact—so quarterly evidence collection becomes a one-click export, not a fire drill.',
  },
];

const SEVERITY_TIERS = [
  {
    band: 'Critical',
    score: '9.0 – 10.0',
    sla: 'Patch within 24 hours',
    behavior:
      'Confirmed exploitable in your environment, internet-reachable, or has an active exploit kit. Page on-call; auto-create remediation ticket tied to owning service.',
    accent: 'destructive' as const,
  },
  {
    band: 'High',
    score: '7.0 – 8.9',
    sla: 'Patch within 7 days',
    behavior:
      'Direct exposure path or business-critical asset. Auto-prioritize by owning team and surface a remediation plan with the exact dependency or config change required.',
    accent: 'high' as const,
  },
  {
    band: 'Medium',
    score: '4.0 – 6.9',
    sla: 'Patch within 30 days',
    behavior:
      'Indirect exposure or limited blast radius. Bundled into the next sprint; weekly digest to the owning service owner.',
    accent: 'medium' as const,
  },
  {
    band: 'Low / Info',
    score: '0.1 – 3.9',
    sla: 'Backlog & track',
    behavior:
      'Hygiene and hardening findings. Surfaced in monthly posture reports; accepted-risk workflow so the team can consciously defer without losing the audit trail.',
    accent: 'low' as const,
  },
];

const FAQS = [
  {
    q: `Does ${brand.name} replace our existing scanner, or augment it?`,
    a: `Either. ${brand.name} ships its own discovery + assessment engine and integrates cleanly with Nessus, Qualys, Wiz, Snyk, and similar tools you already operate. Findings normalize into one prioritized view, so a single Critical from any source drives the same playbook.`,
  },
  {
    q: 'How is this different from a vulnerability dashboard?',
    a: `A dashboard shows you the list. ${brand.name} closes the loop — exploitability scoring ranks findings by real risk to your environment, and remediation playbooks with the exact patch, config change, or compensating control are attached the moment a finding lands.`,
  },
  {
    q: 'Where does the AI sit, and what does it actually do?',
    a: 'Three concrete jobs: (1) exploitability scoring that weighs your actual environment, not just CVSS base; (2) deduplication and grouping across overlapping findings so your team fixes one root cause, not the same CVE ten times; (3) writing the remediation report in the language and format your team already uses.',
  },
  {
    q: 'Is sensitive scan data leaving our environment?',
    a: `No. Assessment runs in your cloud, your VPC, or on-prem. ${brand.name} ships as a managed service OR as a self-hosted control plane — choose based on your data-residency and compliance posture.`,
  },
  {
    q: 'How long from kickoff to first prioritized report?',
    a: 'Discovery begins inside 24 hours of provisioning. The first exploitability-ranked remediation report lands within 72 hours for external surface, and within one week for full internal + cloud + application coverage.',
  },
];

function SeverityDot({ tier }: { tier: (typeof SEVERITY_TIERS)[number]['accent'] }) {
  // Purely semantic — uses var(--destructive) for critical, brand ramp for the rest.
  // No raw colors; flips cleanly with .dark on <html>.
  const cls =
    tier === 'destructive'
      ? 'bg-destructive'
      : tier === 'high'
        ? 'bg-[oklch(0.7_calc(0.18)_55)]'
        : tier === 'medium'
          ? 'bg-[oklch(0.78_calc(0.13)_90)]'
          : 'bg-[oklch(0.7_calc(0.1)_172)]';
  return <span className={`inline-block size-2.5 rounded-full ${cls}`} aria-hidden />;
}

export default function AppHome() {
  return (
    <main id="top" className="relative">
      {/* ===================== HERO ===================== */}
      <section
        aria-labelledby="hero-heading"
        className="relative isolate overflow-hidden border-b border-border"
      >
        {/* Decorative grid + glow — built from semantic tokens so it flips with .dark */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(70%_55%_at_78%_-10%,color-mix(in_oklab,var(--brand-400)_28%,transparent),transparent_60%),radial-gradient(45%_35%_at_8%_0%,color-mix(in_oklab,var(--brand-500)_18%,transparent),transparent_60%)]"
        />
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-72 w-full opacity-[0.18] text-border"
        >
          <title>Decorative grid background</title>
          <defs>
            <pattern id="hero-grid" width="36" height="36" patternUnits="userSpaceOnUse">
              <path d="M 36 0 L 0 0 0 36" fill="none" stroke="currentColor" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#hero-grid)" />
        </svg>

        <div className="container-page grid gap-12 pb-section-lg pt-section-lg lg:grid-cols-[1.1fr_0.9fr] lg:gap-16">
          {/* Left: identity & CTA — offset, NOT centered.
              Vertical-aligns against the right panel with explicit mt- offset. */}
          <div className="flex flex-col gap-7 lg:pt-10">
            <div className="flex items-center gap-2 text-eyebrow">
              <LivePulse />
              <span className="text-eyebrow">24/7 vulnerability intelligence</span>
            </div>

            <h1
              id="hero-heading"
              className="font-display text-display tracking-tight text-foreground animate-in fade-in slide-in-from-bottom-2 duration-700"
            >
              Know what an attacker
              <span className="block text-brand-500">would see, first.</span>
            </h1>

            <p className="max-w-xl text-body-lg text-muted-foreground animate-in fade-in slide-in-from-bottom-3 duration-700 delay-100">
              {`${brand.name} continuously scans your external, internal, and cloud surface — ranking
              every finding by what is actually exploitable in your environment and shipping the
              remediation playbook beside it. No nightly snapshots. No manual triage. No analyst
              backlog.`}
            </p>

            <div className="flex flex-wrap items-center gap-3 animate-in fade-in slide-in-from-bottom-4 duration-700 delay-200">
              <Button asChild size="lg" className="shadow-brand">
                <a href="#trial">Start free trial</a>
              </Button>
              <Button asChild size="lg" variant="ghost">
                <Link href="/pricing">See pricing</Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <a href="#workflow">See how a finding flows</a>
              </Button>
              <Button asChild size="lg" variant="ghost">
                <Link href="/blog">Read the threat-intel blog →</Link>
              </Button>
              <Button asChild size="lg" variant="ghost">
                <a
                  href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(brand.name)}%20demo%20request`}
                >
                  Request a tailored demo
                </a>
              </Button>
            </div>

            <dl className="mt-2 grid max-w-xl grid-cols-3 gap-x-6 gap-y-1 border-t border-border pt-5 text-small text-muted-foreground">
              <div className="flex flex-col">
                <dt className="text-caption uppercase tracking-wider text-muted-foreground/80">
                  Coverage
                </dt>
                <dd className="font-medium text-foreground">External + Internal + Cloud</dd>
              </div>
              <div className="flex flex-col">
                <dt className="text-caption uppercase tracking-wider text-muted-foreground/80">
                  First report
                </dt>
                <dd className="font-medium text-foreground">Within 72 hours</dd>
              </div>
              <div className="flex flex-col">
                <dt className="text-caption uppercase tracking-wider text-muted-foreground/80">
                  Integration
                </dt>
                <dd className="font-medium text-foreground">Jira · Linear · Slack · PagerDuty</dd>
              </div>
            </dl>
          </div>

          {/* Right: live SOC console panel — built from primitives + inline SVG, no images. */}
          <div className="relative">
            <div className="absolute -inset-x-3 -inset-y-2 -z-10 rounded-[var(--radius-xl)] bg-gradient-to-br from-brand-500/15 via-transparent to-brand-700/20 blur-2xl" />
            <Card className="overflow-hidden rounded-[var(--radius-xl)] border-border/80 shadow-xl">
              <div className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <span
                    className="size-2.5 rounded-full bg-[oklch(0.7_calc(0.18)_25)]"
                    aria-hidden
                  />
                  <span
                    className="size-2.5 rounded-full bg-[oklch(0.78_calc(0.13)_90)]"
                    aria-hidden
                  />
                  <span
                    className="size-2.5 rounded-full bg-[oklch(0.7_calc(0.18)_140)]"
                    aria-hidden
                  />
                </div>
                <p className="font-mono text-caption uppercase tracking-[0.18em] text-muted-foreground">
                  soc · live-feed
                </p>
                <div className="flex items-center gap-1.5 text-caption text-muted-foreground">
                  <LivePulse />
                  <span className="font-mono">streaming</span>
                </div>
              </div>

              <ul className="divide-y divide-border font-mono text-small">
                {[
                  {
                    t: '03:14:09',
                    sev: 'CRIT',
                    asset: 'api-gateway.eu-west-1',
                    finding: 'CVE-2024-39014 — auth bypass · remotely exploitable · confirmed',
                    color: 'text-destructive',
                  },
                  {
                    t: '03:13:51',
                    sev: 'HIGH',
                    asset: 'k8s/cluster-prod-2',
                    finding:
                      'IAM role allows sts:AssumeRole across all accounts · blast radius: 14 services',
                    color: 'text-foreground',
                  },
                  {
                    t: '03:12:33',
                    sev: 'HIGH',
                    asset: 'app/web-checkout',
                    finding:
                      'Outdated @stripe/stripe-js@2.4.0 — SCA flagged CVEs in transitive deps',
                    color: 'text-foreground',
                  },
                  {
                    t: '03:11:18',
                    sev: 'MED',
                    asset: 's3/analytics-exports',
                    finding: 'Bucket policy allows s3:GetObject from any principal in partner org',
                    color: 'text-muted-foreground',
                  },
                  {
                    t: '03:10:02',
                    sev: 'MED',
                    asset: 'hosting/edge-fra-04',
                    finding: 'OpenSSL 3.0.12 — renego path; not currently weaponized, monitor feed',
                    color: 'text-muted-foreground',
                  },
                  {
                    t: '03:09:44',
                    sev: 'LOW',
                    asset: 'ci/github-actions',
                    finding: 'Workflow uses pinned-action@SHA near expiry — supply-chain hygiene',
                    color: 'text-muted-foreground',
                  },
                ].map((row) => (
                  <li key={row.t} className="grid grid-cols-[5rem_4rem_1fr] gap-3 px-4 py-2.5">
                    <span className="text-muted-foreground">{row.t}</span>
                    <Badge
                      variant={row.sev === 'CRIT' ? 'destructive' : 'outline'}
                      className="justify-self-start px-1.5 py-0 font-mono text-[0.66rem] tracking-wider"
                    >
                      {row.sev}
                    </Badge>
                    <span className={`truncate ${row.color}`}>
                      <span className="text-muted-foreground">{row.asset}</span>
                      <span className="mx-2 text-border">·</span>
                      {row.finding}
                    </span>
                  </li>
                ))}
              </ul>

              <div className="flex items-center justify-between border-t border-border bg-muted/30 px-4 py-2.5 text-caption text-muted-foreground">
                <span className="font-mono">surface: 2,184 assets · rules: 41,902</span>
                <span className="font-mono">next scan: 00:14:22</span>
              </div>
            </Card>
          </div>
        </div>
      </section>

      {/* ===================== TRUST BAND ===================== */}
      <section aria-label="Built for" className="container-page border-b border-border py-8">
        <p className="text-caption text-muted-foreground">
          Built for the operators responsible for keeping production running and auditors satisfied
          — across
        </p>
        <ul className="mt-3 flex flex-wrap gap-2">
          {[
            'Enterprise security teams',
            'DevSecOps pipelines',
            'Cloud-native platforms',
            'Regulated industries (SOC 2 · ISO 27001 · HIPAA · PCI)',
            'MSSP / MDR service delivery',
          ].map((label) => (
            <li key={label}>
              <Badge variant="secondary" className="font-normal">
                {label}
              </Badge>
            </li>
          ))}
        </ul>
      </section>

      {/* ===================== CAPABILITIES ===================== */}
      <section
        id="capabilities"
        aria-labelledby="capabilities-heading"
        className="container-page section-lg scroll-mt-20"
      >
        <div className="grid items-end gap-6 lg:grid-cols-[1.05fr_1fr]">
          <div>
            <p className="text-eyebrow">Coverage map</p>
            <h2
              id="capabilities-heading"
              className="mt-3 font-display text-h1 tracking-tight text-foreground"
            >
              Six surfaces, one ranked queue.
            </h2>
          </div>
          <p className="max-w-prose text-body-lg text-muted-foreground">
            {`Every asset ${brand.name} can reach is folded into the same exploitability-ranked queue — so
            your team works the same backlog whether the next finding came from the perimeter, the
            cloud account, or a transitive npm dependency.`}
          </p>
        </div>

        {/* Asymmetric 6-item grid: row 1 has a wide left card (spans 2); row 2 is mismatch (5/7 col).
            Avoids the "three identical cards in a row" skeleton. */}
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {CAPABILITIES.map((c, i) => {
            const wide = i === 0 || i === 3;
            return (
              <Card
                key={c.index}
                className={`lift group relative overflow-hidden border-border/80 bg-card ${
                  wide ? 'md:col-span-2' : ''
                }`}
              >
                <CardContent className="flex h-full flex-col gap-3 p-6">
                  <div className="flex items-start justify-between gap-4">
                    <span className="font-mono text-caption tracking-widest text-brand-500">
                      {c.index}
                    </span>
                    <Badge variant="outline" className="font-normal text-muted-foreground">
                      {c.area}
                    </Badge>
                  </div>
                  <h3 className="font-display text-h4 tracking-tight text-foreground">{c.title}</h3>
                  <p className="text-body text-muted-foreground">{c.body}</p>
                  <div className="mt-auto h-px w-12 bg-gradient-to-r from-brand-500 to-transparent transition-all duration-300 group-hover:w-32" />
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      {/* ===================== WORKFLOW / HOW IT WORKS ===================== */}
      <section
        id="workflow"
        aria-labelledby="workflow-heading"
        className="relative border-y border-border bg-muted/30 section-lg scroll-mt-20"
      >
        <div className="container-page">
          <div className="grid items-end gap-6 lg:grid-cols-[1fr_1.4fr]">
            <div>
              <p className="text-eyebrow">How a finding flows</p>
              <h2
                id="workflow-heading"
                className="mt-3 font-display text-h1 tracking-tight text-foreground"
              >
                From raw CVE to a closed ticket — without triage theatre.
              </h2>
            </div>
            <p className="max-w-prose text-body-lg text-muted-foreground">
              {`${brand.name} doesn’t surface a list and call it done. Each finding is scored,
              grouped with its siblings, attached to the owning service, and pushed into the same
              board where the rest of your engineering work already lives.`}
            </p>
          </div>

          <ol className="mt-14 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {[
              {
                step: '01',
                kicker: 'Discover',
                title: 'Enumerate the surface',
                body: 'External, internal, cloud, and application surfaces are continuously enumerated — including shadow assets nothing else can see.',
              },
              {
                step: '02',
                kicker: 'Assess',
                title: 'Score exploitability',
                body: 'CVSS base is one input. We layer in your actual exposure path, identity blast-radius, and active-exploit evidence before ranking.',
              },
              {
                step: '03',
                kicker: 'Prioritize',
                title: 'Group and route',
                body: 'Findings collapse to a single root cause; the resulting ticket lands in the owning team’s queue with the exact patch and SLA.',
              },
              {
                step: '04',
                kicker: 'Remediate',
                title: 'Close the loop',
                body: 'Re-scan confirms fix; the audit trail (who, when, what proof) is captured automatically against the relevant compliance framework.',
              },
            ].map((s, i) => (
              <li key={s.step} className="relative">
                {/* Connector line for desktop — uses token color, flips with .dark */}
                {i < 3 ? (
                  <span
                    aria-hidden
                    className="absolute left-[1.65rem] top-10 hidden h-px w-[calc(100%-2rem)] bg-gradient-to-r from-brand-500/70 via-brand-500/30 to-transparent lg:block"
                  />
                ) : null}
                <div className="flex items-center gap-3">
                  <span className="font-mono text-h3 text-brand-500">{s.step}</span>
                  <span className="font-display text-caption uppercase tracking-[0.18em] text-muted-foreground">
                    {s.kicker}
                  </span>
                </div>
                <h3 className="mt-3 font-display text-h4 tracking-tight text-foreground">
                  {s.title}
                </h3>
                <p className="mt-2 text-body text-muted-foreground">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ===================== SEVERITY MODEL ===================== */}
      <section
        id="severity"
        aria-labelledby="severity-heading"
        className="container-page section-lg scroll-mt-20"
      >
        <div className="grid items-end gap-6 lg:grid-cols-[1fr_1.4fr]">
          <div>
            <p className="text-eyebrow">Severity model</p>
            <h2
              id="severity-heading"
              className="mt-3 font-display text-h1 tracking-tight text-foreground"
            >
              Ranked like an attacker ranks you — not like a vendor demo.
            </h2>
          </div>
          <p className="max-w-prose text-body-lg text-muted-foreground">
            {`${brand.name} translates a CVSS base score plus your live exposure into a four-tier model
            with explicit SLAs. No “Critical” inflation; no “you decide”
            handoffs. Every tier maps to a concrete action.`}
          </p>
        </div>

        <div className="mt-12 overflow-hidden rounded-[var(--radius-xl)] border border-border bg-card shadow-sm">
          <div className="hidden grid-cols-[1.2fr_0.9fr_0.9fr_2.4fr] border-b border-border bg-muted/50 px-6 py-3 text-caption font-semibold uppercase tracking-wider text-muted-foreground md:grid">
            <span>Tier</span>
            <span>CVSS range</span>
            <span>SLA</span>
            <span>What happens</span>
          </div>
          <ul className="divide-y divide-border">
            {SEVERITY_TIERS.map((t) => (
              <li
                key={t.band}
                className="grid grid-cols-1 gap-y-3 px-6 py-5 md:grid-cols-[1.2fr_0.9fr_0.9fr_2.4fr] md:items-start md:gap-x-6"
              >
                <div className="flex items-center gap-3">
                  <SeverityDot tier={t.accent} />
                  <span className="font-display text-h4 text-foreground">{t.band}</span>
                </div>
                <div className="font-mono text-small text-muted-foreground">
                  <span className="md:hidden text-caption uppercase tracking-wider text-muted-foreground/80">
                    CVSS ·{' '}
                  </span>
                  {t.score}
                </div>
                <div className="text-small font-medium text-foreground">
                  <span className="md:hidden text-caption uppercase tracking-wider text-muted-foreground/80">
                    SLA ·{' '}
                  </span>
                  {t.sla}
                </div>
                <p className="text-body text-muted-foreground">{t.behavior}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ===================== OUTCOME / STATS ===================== */}
      <section aria-labelledby="outcomes-heading" className="border-y border-border bg-card/40">
        <div className="container-page section">
          <h2 id="outcomes-heading" className="sr-only">
            {`What changes when ${brand.name} runs`}
          </h2>
          <div className="grid gap-6 md:grid-cols-3">
            {[
              {
                stat: '11×',
                label: 'faster mean time to remediation',
                detail:
                  'Across pilot deployments, the time from new CVE publication to closure in production drops by an order of magnitude.',
              },
              {
                stat: '93%',
                label: 'of Criticals closed within SLA',
                detail:
                  'Auto-ticketed, auto-routed, and tracked against owner — no analyst needed to babysit the queue.',
              },
              {
                stat: '< 1 hr',
                label: 'to first ranked finding, not first scan',
                detail:
                  'Discovery begins immediately; exploitability-ranked reports ship before the next standup.',
              },
            ].map((s) => (
              <div
                key={s.label}
                className="flex flex-col gap-2 border-l-2 border-brand-500/70 pl-5"
              >
                <p className="font-display text-h1 leading-none text-foreground">{s.stat}</p>
                <p className="font-display text-h4 text-foreground">{s.label}</p>
                <p className="text-small text-muted-foreground">{s.detail}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ===================== FOUNDER / ORIGIN ===================== */}
      <section aria-labelledby="origin-heading" className="container-page section-lg">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr] lg:gap-16">
          <div className="flex flex-col gap-4">
            <p className="text-eyebrow">Origin</p>
            <h2 id="origin-heading" className="font-display text-h2 tracking-tight text-foreground">
              Built where vulnerability research meets the SOC floor.
            </h2>
            <p className="max-w-prose text-body-lg text-muted-foreground">
              {`${brand.name} was founded to put an end to the same loop — stop building dashboards
              that name the problem and start shipping the remediation alongside it, at enterprise
              scale, around the clock, without an analyst in the loop. Continuous external-surface
              monitoring, ranked by exploitability against each customer’s real asset context,
              with the patch payload attached to every finding.`}
            </p>
          </div>

          {/* Citation card — semantic styling, no images. */}
          <Card className="relative overflow-hidden border-border/80 bg-card">
            <span
              aria-hidden
              className="pointer-events-none absolute -left-6 -top-2 font-display text-[6rem] leading-none text-brand-500/20"
            >
              &ldquo;
            </span>
            <CardContent className="flex flex-col gap-4 p-7">
              <p className="font-display text-h4 leading-snug text-foreground">
                The point of vulnerability management is not to know about vulnerabilities. It is to
                have fewer of them, sooner.
              </p>
              <footer className="text-small text-muted-foreground">
                <span className="font-medium text-foreground">Founder</span>
              </footer>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* ===================== FAQ ===================== */}
      <section
        id="faq"
        aria-labelledby="faq-heading"
        className="border-t border-border bg-muted/30 section-lg scroll-mt-20"
      >
        <div className="container-page grid gap-10 lg:grid-cols-[1fr_1.6fr]">
          <div>
            <p className="text-eyebrow">Frequently asked</p>
            <h2
              id="faq-heading"
              className="mt-3 font-display text-h1 tracking-tight text-foreground"
            >
              Questions security leaders actually ask before deploying.
            </h2>
          </div>
          <Accordion
            type="single"
            collapsible
            className="rounded-[var(--radius-lg)] border border-border bg-card px-2 shadow-sm"
          >
            {FAQS.map((f, i) => (
              <AccordionItem
                key={f.q}
                value={`faq-${i}`}
                className={i === FAQS.length - 1 ? 'border-b-0' : ''}
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

      {/* ===================== TRIAL ===================== */}
      <section
        id="trial"
        aria-labelledby="trial-heading"
        className="container-page section-lg scroll-mt-20"
      >
        <div className="relative isolate overflow-hidden rounded-[var(--radius-2xl)] border border-border bg-card px-6 py-14 shadow-lg sm:px-10 lg:px-14">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_60%_at_12%_0%,color-mix(in_oklab,var(--brand-500)_30%,transparent),transparent_55%),radial-gradient(45%_55%_at_100%_100%,color-mix(in_oklab,var(--brand-400)_22%,transparent),transparent_60%)]"
          />
          <div className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-start">
            <div className="flex flex-col gap-5">
              <p className="text-eyebrow">No sales call required</p>
              <h2
                id="trial-heading"
                className="font-display text-h1 tracking-tight text-foreground"
              >
                Stand up a {brand.name} workspace in under a minute.
              </h2>
              <p className="max-w-prose text-body-lg text-muted-foreground">
                We provision a 14-day team workspace, seed it with a sample internet-facing asset
                inventory + prioritized CVEs, and email you a one-time link to claim it. No credit
                card. Bring your team when you&apos;re ready — invite from the workspace.
              </p>
              <ul className="grid gap-2 text-body text-foreground">
                <li className="flex items-start gap-2">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand-500" aria-hidden />
                  <span>
                    Deterministic sample scan so the dashboard renders populated on first load
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand-500" aria-hidden />
                  <span>14-day window — convert to a paid plan from inside the workspace</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand-500" aria-hidden />
                  <span>
                    Connect AWS / Azure / GCP and run a live scan against your real surface when
                    you&apos;re ready
                  </span>
                </li>
              </ul>
            </div>
            <TrialCta />
          </div>
        </div>
      </section>

      {/* ===================== CTA ===================== */}
      <section
        id="contact"
        aria-labelledby="contact-heading"
        className="container-page section-lg scroll-mt-20"
      >
        <div className="relative isolate overflow-hidden rounded-[var(--radius-2xl)] border border-border bg-card px-6 py-14 shadow-lg sm:px-10 lg:px-14">
          {/* Decorative vignette using tokens — flips with .dark */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(55%_70%_at_85%_15%,color-mix(in_oklab,var(--brand-500)_30%,transparent),transparent_55%),radial-gradient(45%_60%_at_0%_100%,color-mix(in_oklab,var(--brand-400)_22%,transparent),transparent_60%)]"
          />
          <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr] lg:items-center">
            <div className="flex flex-col gap-4">
              <p className="text-eyebrow">Get in touch</p>
              <h2
                id="contact-heading"
                className="font-display text-h1 tracking-tight text-foreground"
              >
                Book a tailored demo against your real surface.
              </h2>
              <p className="max-w-prose text-body-lg text-muted-foreground">
                Tell us the stack, the regulatory posture, and the bottleneck. We&apos;ll come back
                with a scoped pilot that ranks findings against your own environment — usually
                within 72 hours.
              </p>
            </div>
            <Card className="border-border/80 bg-background/60 backdrop-blur-sm">
              <CardContent className="flex flex-col gap-5 p-7">
                <div>
                  <p className="text-caption uppercase tracking-wider text-muted-foreground">
                    Direct line
                  </p>
                  <a
                    href={`mailto:${CONTACT_EMAIL}`}
                    className="mt-1 block font-display text-h3 tracking-tight text-foreground transition-colors hover:text-brand-500"
                  >
                    {CONTACT_EMAIL}
                  </a>
                </div>
                <div className="flex flex-wrap gap-3">
                  <Button asChild className="shadow-brand">
                    <Link href="/contact">Open the contact form</Link>
                  </Button>
                  <Button asChild variant="outline">
                    <a
                      href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(brand.name)}%20-%20procurement%20%26%20security%20review`}
                    >
                      Request security review packet
                    </a>
                  </Button>
                </div>
                <p className="text-small text-muted-foreground">
                  Replies typically within one business day.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>
    </main>
  );
}
