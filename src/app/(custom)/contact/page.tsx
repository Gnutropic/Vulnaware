// @polsia:user-owned — public /contact route. Server Component so it can
// export per-page metadata (POL-2616). Renders one 'use client' island
// (ContactForm); no data fetch, no auth gate.

import { Clock, Mail, ShieldCheck } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ComponentType } from 'react';
import { ContactForm } from '@/components/custom/contact-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { brand } from '@/lib/brand';
import { siteName } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Contact us',
  description: `Tell ${brand.name} about your stack, regulatory posture, or procurement review. Replies within one business day.`,
  alternates: { canonical: '/contact' },
  openGraph: {
    type: 'website',
    url: '/contact',
    siteName,
    title: `Contact us · ${siteName}`,
    description: `Reach the ${brand.name} team for demos, procurement, security review, or partnership inquiries.`,
  },
  twitter: {
    card: 'summary_large_image',
    title: `Contact us · ${siteName}`,
    description: `Reach the ${brand.name} team for demos, procurement, security review, or partnership inquiries.`,
  },
};

const CONTACT_EMAIL = brand.contactEmail;

interface PillarCard {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: string;
  body: string;
}
const RESPONSE_PILLARS: PillarCard[] = [
  {
    icon: Clock,
    title: 'One business day',
    body: 'A real human on the VulnAware team replies — usually within a few hours during US/EU business times. No nurture sequence, no SDR shuffle.',
  },
  {
    icon: Mail,
    title: 'Direct line, not a CRM',
    body: 'Your message lands in the same inbox the founders read. Procurement, security, technical, partnerships — all the same address.',
  },
  {
    icon: ShieldCheck,
    title: 'No tracking pixels',
    body: 'The form is plain HTML + a server POST. We don’t enrich your submission with third-party data, and we don’t sell the address.',
  },
];

const ROUTES: { label: string; description: string; href: string; cta: string }[] = [
  {
    label: 'Sales / demo',
    description:
      'You want a scoped pilot that runs against your real external surface so you can see exploitability-ranked findings on your own assets.',
    href: '/pricing',
    cta: 'View pricing',
  },
  {
    label: 'Procurement / security review',
    description:
      'You’re buying for a regulated environment and need the SOC 2 readiness pack, DPA, SCCs, and an architecture diagram before signing.',
    href: '/security',
    cta: 'Open the security page',
  },
  {
    label: 'Self-serve trial',
    description:
      'You’re ready to kick the tires without a sales call. A 14-day workspace, a sample asset inventory, and one ranked CVE queue — no credit card.',
    href: '/#trial',
    cta: 'Start a trial',
  },
];

export default function ContactPage() {
  return (
    <main className="relative">
      {/* ===================== HERO ===================== */}
      <section
        aria-labelledby="contact-heading"
        className="relative isolate overflow-hidden border-b border-border"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(68%_55%_at_82%_-12%,color-mix(in_oklab,var(--brand-400)_30%,transparent),transparent_60%),radial-gradient(45%_35%_at_6%_0%,color-mix(in_oklab,var(--brand-500)_18%,transparent),transparent_60%)]"
        />
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-72 w-full opacity-[0.16] text-border"
        >
          <title>Decorative grid background</title>
          <defs>
            <pattern id="contact-grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="currentColor" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#contact-grid)" />
        </svg>

        <div className="container-page grid gap-6 pb-section-lg pt-section-lg lg:grid-cols-[1.05fr_0.95fr] lg:items-end lg:gap-12">
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-2 text-eyebrow">
              <Badge variant="outline" className="font-normal text-muted-foreground">
                Contact
              </Badge>
              <span className="text-eyebrow">Replies within one business day</span>
            </div>
            <h1
              id="contact-heading"
              className="font-display text-display tracking-tight text-foreground animate-in fade-in slide-in-from-bottom-2 duration-700"
            >
              Tell us about your{' '}
              <span className="block text-brand-500">vulnerability surface.</span>
            </h1>
            <p className="max-w-xl text-body-lg text-muted-foreground">
              {`Whether you’re scoping a pilot, running procurement, or wanting to talk
              shop about exploitability scoring, this is the inbox that lands in front
              of the VulnAware team. Bring your stack, your regulatory posture, and
              whatever you’re worried about — we’ll come back with an answer.`}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button asChild variant="outline">
                <Link href="/pricing">See pricing</Link>
              </Button>
              <Button asChild variant="ghost">
                <Link href="/#trial">Or start a self-serve trial →</Link>
              </Button>
            </div>
          </div>

          {/* Right: response-promise pillars in a tight stack */}
          <dl className="grid gap-3 rounded-[var(--radius-xl)] border border-border bg-card/60 p-5 shadow-sm backdrop-blur-sm">
            {RESPONSE_PILLARS.map((p) => (
              <div key={p.title} className="flex items-start gap-4">
                <span
                  aria-hidden
                  className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-brand-500/15 text-brand-500"
                >
                  <p.icon className="size-4" />
                </span>
                <div className="flex flex-col gap-1">
                  <dt className="font-display text-h4 text-foreground">{p.title}</dt>
                  <dd className="text-small text-muted-foreground">{p.body}</dd>
                </div>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ===================== FORM + DIRECT LINE ===================== */}
      <section aria-labelledby="contact-form-heading" className="container-page section-lg">
        <div className="grid items-start gap-12 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="flex flex-col gap-5">
            <p className="text-eyebrow">Send a message</p>
            <h2
              id="contact-form-heading"
              className="font-display text-h1 tracking-tight text-foreground"
            >
              The fastest way to get a real human on the line.
            </h2>
            <p className="max-w-prose text-body-lg text-muted-foreground">
              The form posts straight to a server endpoint and a single email lands in our shared
              inbox. We never share the address, never enrich it with third-party data, and never
              add you to a sequence.
            </p>
            <Separator className="my-2 max-w-[6rem] bg-brand-500/60" />
            <ContactForm />
          </div>

          <aside className="flex flex-col gap-6">
            <Card className="relative overflow-hidden border-border/80 bg-card shadow-md">
              <span
                aria-hidden
                className="pointer-events-none absolute -left-4 -top-3 font-display text-[5rem] leading-none text-brand-500/20"
              >
                &ldquo;
              </span>
              <CardContent className="flex flex-col gap-4 p-6 sm:p-8">
                <p className="text-eyebrow">Direct line</p>
                <p className="font-display text-h3 tracking-tight text-foreground">
                  Prefer email? Same inbox.
                </p>
                <a
                  href={`mailto:${CONTACT_EMAIL}`}
                  className="block break-all font-display text-h3 tracking-tight text-foreground transition-colors hover:text-brand-500"
                >
                  {CONTACT_EMAIL}
                </a>
                <div className="flex flex-wrap gap-3 pt-2">
                  <Button asChild variant="outline">
                    <a
                      href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`${brand.name} - procurement & security review`)}`}
                    >
                      Request security review packet
                    </a>
                  </Button>
                  <Button asChild variant="ghost">
                    <a
                      href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`${brand.name} - book a demo`)}`}
                    >
                      Or book a demo →
                    </a>
                  </Button>
                </div>
                <p className="text-small text-muted-foreground">
                  Replies typically within one business day.
                </p>
              </CardContent>
            </Card>

            <Card className="border-border/80 bg-muted/30">
              <CardContent className="flex flex-col gap-3 p-6">
                <p className="text-eyebrow">Already mid-evaluation?</p>
                <p className="text-body text-foreground">
                  {`If your team is already trialing ${brand.name}, jump straight into the
                  dashboard and message your assigned analyst there — it’s faster and
                  keeps the conversation in one thread.`}
                </p>
                <div>
                  <Button asChild variant="link" className="px-0">
                    <Link href="/scans">Open the dashboard →</Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          </aside>
        </div>
      </section>

      {/* ===================== ROUTE BY USE-CASE ===================== */}
      <section
        aria-labelledby="routes-heading"
        className="border-t border-border bg-muted/30 section-lg"
      >
        <div className="container-page grid gap-10 lg:grid-cols-[1fr_1.6fr]">
          <div>
            <p className="text-eyebrow">Pick the right door</p>
            <h2
              id="routes-heading"
              className="mt-3 font-display text-h1 tracking-tight text-foreground"
            >
              Different questions, different paths.
            </h2>
            <p className="mt-4 max-w-prose text-body-lg text-muted-foreground">
              The same inbox handles all of these — but if you know exactly what you’re after, the
              targeted pages below skip a back-and-forth.
            </p>
          </div>
          <ul className="grid gap-4 md:grid-cols-3">
            {ROUTES.map((r) => (
              <li key={r.label}>
                <Card className="lift h-full border-border/80 bg-card">
                  <CardContent className="flex h-full flex-col gap-4 p-6">
                    <p className="font-display text-h4 tracking-tight text-foreground">{r.label}</p>
                    <p className="text-body text-muted-foreground">{r.description}</p>
                    <div className="mt-auto">
                      <Button asChild variant="link" className="px-0">
                        <Link href={r.href}>{r.cta} →</Link>
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  );
}
