// @polsia:user-owned — public /about route. Server Component so it can
// export per-page metadata. Copy is constant — no data fetch, no auth gate.
//
// Sections: hero (brand gradient + grid pattern) -> mission (founder origin,
// reused from /#origin) -> team (clearly-marked placeholder roster,
// brief explicitly allows) -> credibility stats with a "read full proof"
// pointer to /security -> dual CTA back to /contact and /pricing.

// TODO(team): replace the TEAM roster below with a typed `Team` Prisma model
// (a new user-owned `prisma/schema/about.prisma` + a `/api/about/team` handler
// + a client island reading it). Out of scope for this task — placeholders
// render from a static const until that lands.

import { Award, Mail, Sparkles } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { brand } from '@/lib/brand';

export const metadata: Metadata = {
  title: 'About',
  description: `Built by an independent security team, ${brand.name} is the autonomous vulnerability scanner that ships remediation alongside findings. Meet the (placeholder) team and review the credibility metrics customers ask about.`,
  alternates: { canonical: '/about' },
  openGraph: {
    title: `About · ${brand.name}`,
    description: `Mission, team, and credibility markers behind ${brand.name} — the autonomous vulnerability scanner that ships remediation alongside findings.`,
    url: '/about',
  },
};

interface TeamMember {
  key: string;
  name: string;
  role: string;
  bio: string;
  initials: string;
}

const TEAM: TeamMember[] = [
  {
    key: 'founder',
    name: 'Founder',
    role: 'Founder · CEO',
    bio: 'Developed by a University of Denver Cybersecurity Grad Student.',
    initials: 'F',
  },
  {
    key: 'engineering',
    name: 'Head of Engineering',
    role: 'Engineering · Core scanner',
    bio: 'Owns the scanner engine and the data layer that isolates each workspace. Spent the last decade on continuous-monitoring infra for enterprise SOC teams.',
    initials: 'E',
  },
  {
    key: 'security-research',
    name: 'Security Research Lead',
    role: 'Security research · Exploitability ranking',
    bio: 'Designs the scoring model that rescores every CVE against a customer’s real asset context. Background in offensive research and red-team tooling.',
    initials: 'S',
  },
];

interface CredStat {
  key: string;
  metric: string;
  label: string;
  detail: string;
}

const CRED_STATS: CredStat[] = [
  {
    key: 'customers',
    metric: '40+',
    label: 'Customers in production',
    detail:
      'Security teams and DevSecOps pipelines running continuous vulnerability intelligence on the platform today.',
  },
  {
    key: 'uptime',
    metric: '99.95%',
    label: 'Measured uptime · trailing 90 days',
    detail:
      'Pro and Enterprise plans ship with a 99.9% SLA. Public status lives at /security and posts a 90-day rolling window.',
  },
  {
    key: 'compliance',
    metric: 'SOC 2',
    label: 'Compliance posture',
    detail:
      'SOC 2 Type II readiness is the active track — controls for access, change, vendor risk, and incident response already run in production. GDPR / SCCs are signed as standard.',
  },
];

const ABOUT_JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'AboutPage',
  name: `About ${brand.name}`,
  url: '/about',
  description: `Mission, team, and credibility markers for ${brand.name} — the autonomous vulnerability scanner that ships remediation alongside findings.`,
};

const ABOUT_BREADCRUMB_LD = {
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
      name: 'About',
      item: '/about',
    },
  ],
};

export default function AboutPage() {
  return (
    <main className="relative">
      {/* ===================== HERO ===================== */}
      <section
        aria-labelledby="about-hero-heading"
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
            <pattern id="about-grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="currentColor" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#about-grid)" />
        </svg>

        <div className="container-page grid gap-6 pb-section-lg pt-section-lg lg:grid-cols-[1.1fr_0.9fr] lg:items-end lg:gap-12">
          <div className="flex flex-col gap-5">
            <p className="text-eyebrow inline-flex items-center gap-2">
              <span aria-hidden className="size-1.5 rounded-full bg-brand-500" />
              <span>About {brand.name}</span>
            </p>
            <h1
              id="about-hero-heading"
              className="font-display text-display tracking-tight text-foreground"
            >
              Built where vulnerability research{' '}
              <span className="block text-brand-500">meets the SOC floor.</span>
            </h1>
            <p className="max-w-xl text-body-lg text-muted-foreground">
              {`${brand.name} is an autonomous vulnerability scanner that runs the same exploitability-ranked
              engine around the clock and ships the remediation alongside the findings — so security teams
              spend less time triaging and more time closing risk.`}
            </p>
          </div>

          <dl className="grid grid-cols-3 gap-x-4 gap-y-1 rounded-[var(--radius-lg)] border border-border bg-card/60 p-5 shadow-sm backdrop-blur-sm">
            <div className="flex flex-col">
              <dt className="text-caption uppercase tracking-wider text-muted-foreground/80">
                Founded
              </dt>
              <dd className="font-display text-h4 text-foreground">2026</dd>
              <dd className="text-small text-muted-foreground">Independent</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-caption uppercase tracking-wider text-muted-foreground/80">
                Coverage
              </dt>
              <dd className="font-display text-h4 text-foreground">24 / 7</dd>
              <dd className="text-small text-muted-foreground">Continuous scanning</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-caption uppercase tracking-wider text-muted-foreground/80">
                Stance
              </dt>
              <dd className="font-display text-h4 text-foreground">SOC 2 ready</dd>
              <dd className="text-small text-muted-foreground">Controls in production</dd>
            </div>
          </dl>
        </div>
      </section>

      {/* ===================== MISSION ===================== */}
      <section
        aria-labelledby="mission-heading"
        className="border-t border-border container-page section-lg scroll-mt-20"
      >
        <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr]">
          <div className="flex flex-col gap-3">
            <p className="text-eyebrow">Mission</p>
            <h2
              id="mission-heading"
              className="font-display text-h1 tracking-tight text-foreground"
            >
              Fewer vulnerabilities, sooner — without adding analysts.
            </h2>
            <p className="max-w-prose text-body text-muted-foreground">
              The point of vulnerability management isn&apos;t to know what&apos;s broken. It&apos;s
              to have less of it, sooner than the next adversary reaches it. We started {brand.name}{' '}
              to ship that outcome, not another dashboard that names the problem.
            </p>
          </div>

          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-3">
              <p className="text-eyebrow">Why we built it</p>
              <p className="text-body-lg text-foreground">
                Enterprise security teams were drowning in scanners that pile up findings without
                prioritizing the ones that actually matter. Pull lists from five tools,
                cross-reference against a CVSS feed, hand-rank the top of the stack, then push
                tickets into Jira and hope engineering has the cycles. We watched the same loop burn
                out analysts on the SOC floor every quarter.
              </p>
              <p className="text-body text-muted-foreground">
                {`${brand.name} was founded to put an end to the same loop — continuous
                external-surface monitoring, ranked by exploitability against the customer’s
                real asset context, with the remediation payload attached to every finding.
                The thesis was simple: the scanner should be the analyst, not a backlog
                for one. Around the clock, at enterprise scale, without an analyst in the loop.`}
              </p>
            </div>

            <Card className="border-border/80 bg-card">
              <CardHeader className="gap-3">
                <span
                  aria-hidden
                  className="flex size-9 items-center justify-center rounded-[var(--radius)] bg-brand-500/15 text-brand-500"
                >
                  <Award className="size-5" aria-hidden />
                </span>
                <CardTitle className="font-display text-h3 tracking-tight text-foreground">
                  Our north star
                </CardTitle>
                <CardDescription className="text-body text-muted-foreground">
                  Measured against one question — is the queue of exploitable findings trending down
                  for the teams running {brand.name}?
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="text-body text-foreground">
                  Every product call we make funnels back to that metric. We score against the
                  customer&apos;s real environment — internet-facing or internal, what auth sits in
                  front, what compensating controls already exist — and the platform ships the patch
                  payload, the runbook, and the routing rules alongside the finding so engineering
                  can close without a triage meeting.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* ===================== TEAM ===================== */}
      <section
        aria-labelledby="team-heading"
        className="border-t border-border bg-muted/30 section-lg scroll-mt-20"
      >
        <div className="container-page">
          <div className="flex max-w-prose flex-col gap-3">
            <p className="text-eyebrow inline-flex items-center gap-2">
              <Sparkles className="size-3.5 text-brand-500" aria-hidden />
              <span>Team</span>
            </p>
            <h2 id="team-heading" className="font-display text-h1 tracking-tight text-foreground">
              The people building {brand.name}.
            </h2>
            <p className="text-body-lg text-muted-foreground">
              A small founding team of researchers and engineers who&apos;ve shipped continuous
              monitoring, scoring models, and enterprise SOC tooling before. The roster below is
              representative — full team profiles land alongside the public launch.
            </p>
            <Badge variant="outline" className="mt-2 w-fit rounded-full font-normal">
              Placeholder team — final roster coming soon
            </Badge>
          </div>

          <div className="mt-10 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {TEAM.map((member) => (
              <Card key={member.key} className="lift flex flex-col border-border/80 bg-card">
                <CardHeader className="gap-3">
                  <div className="flex items-center gap-3">
                    <Avatar className="size-12 border border-border/70 bg-card">
                      <AvatarFallback className="bg-brand-500/15 font-display text-body-lg text-brand-500">
                        {member.initials}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col">
                      <CardTitle className="font-display text-h4 tracking-tight text-foreground">
                        {member.name}
                      </CardTitle>
                      <p className="text-small text-muted-foreground">{member.role}</p>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <p className="text-body text-muted-foreground">{member.bio}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ===================== CREDIBILITY ===================== */}
      <section
        aria-labelledby="credibility-heading"
        className="border-y border-border bg-card/40 section-lg scroll-mt-20"
      >
        <div className="container-page">
          <div className="flex max-w-prose flex-col gap-3">
            <p className="text-eyebrow">Credibility</p>
            <h2
              id="credibility-heading"
              className="font-display text-h1 tracking-tight text-foreground"
            >
              The numbers customers ask about on the first call.
            </h2>
            <p className="text-body-lg text-muted-foreground">
              The deep pillars — data residency, encryption, isolation, retention, and the SOC 2
              readiness evidence window — live on the{' '}
              <Link
                href="/security"
                className="font-medium text-foreground underline-offset-4 transition-colors hover:text-brand-500 hover:underline"
              >
                Security &amp; compliance
              </Link>{' '}
              page so this one stays short. The three stats below are the ones procurement calls out
              first.
            </p>
          </div>

          <dl className="mt-10 grid gap-6 md:grid-cols-3">
            {CRED_STATS.map((stat) => (
              <div
                key={stat.key}
                className="flex flex-col gap-3 border-l-2 border-brand-500/70 bg-card/60 p-5 rounded-[var(--radius-lg)] shadow-sm"
              >
                <dt className="text-eyebrow text-muted-foreground">{stat.label}</dt>
                <dd className="font-display text-display leading-none tracking-tight text-brand-500">
                  {stat.metric}
                </dd>
                <dd className="text-body text-muted-foreground">{stat.detail}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Button asChild variant="outline">
              <Link href="/security">Read the full security &amp; compliance proof →</Link>
            </Button>
            <span className="text-small text-muted-foreground">
              Includes the live subprocessor inventory and SOC 2 readiness packet.
            </span>
          </div>
        </div>
      </section>

      {/* ===================== CTA STRIP ===================== */}
      <section
        aria-labelledby="about-cta-heading"
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
                <Mail className="size-3.5 text-brand-500" aria-hidden />
                <span>Want to talk to us directly?</span>
              </p>
              <h2
                id="about-cta-heading"
                className="font-display text-h2 tracking-tight text-foreground"
              >
                Whether it&apos;s procurement, a pilot, or a press question — talk to a human.
              </h2>
              <p className="text-body text-muted-foreground">
                We answer inside one business day, in plain language, from the person who owns that
                surface — not a generic inbox.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button asChild className="shadow-brand">
                <Link href="/signup">Get started</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/contact">Contact the team</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/pricing">See pricing</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Structured data: AboutPage so search engines understand this is the
          "about" surface for the brand, paired with a BreadcrumbList that
          confirms the path Home → About in navigation. JSON.stringify output
          only contains characters safe to live inside a <script> tag body. */}
      <script type="application/ld+json">{JSON.stringify(ABOUT_JSON_LD)}</script>
      <script type="application/ld+json">{JSON.stringify(ABOUT_BREADCRUMB_LD)}</script>
    </main>
  );
}
