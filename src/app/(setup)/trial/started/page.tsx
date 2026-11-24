// @polsia:user-owned — /trial/started — Welcome/onboarding shell for a freshly
// provisioned trial workspace.
//
// Server Component so it exports `metadata` for SEO. The page itself is
// static copy; the interactive OnboardingStepper is the only client island
// (it fetches /api/trial-status + /api/trial-progress via apiFetch).

import { Sparkles } from 'lucide-react';
import type { Metadata } from 'next';
import { OnboardingStepper } from '@/components/custom/trial/onboarding-stepper';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { brand } from '@/lib/brand';
import { siteName } from '@/lib/site';

export const metadata: Metadata = {
  title: `Welcome to ${siteName}`,
  description: `Your ${brand.name} trial workspace is ready — sample data is live. Connect a cloud account, invite a teammate, or open a scan.`,
  alternates: { canonical: '/trial/started' },
};

export default function TrialStartedPage() {
  return (
    <main
      id="top"
      className="container-page section-lg grid gap-8"
      aria-labelledby="trial-welcome-heading"
    >
      <Badge
        variant="secondary"
        className="w-fit border border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-700 dark:bg-brand-900/40 dark:text-brand-200"
      >
        <Sparkles className="mr-1.5 size-3.5" aria-hidden /> 14-day trial · sample data live
      </Badge>

      <header className="grid gap-3">
        <h1
          id="trial-welcome-heading"
          className="font-display text-display tracking-tight text-foreground"
        >
          Your workspace is ready.
        </h1>
        <p className="max-w-prose text-body-lg text-muted-foreground">
          We&apos;ve provisioned your team workspace, seeded it with a sample internet-facing asset
          inventory, and preloaded a deterministic set of CVEs so the dashboard renders populated
          the moment you sign in. Follow the steps below to make this workspace yours.
        </p>
      </header>

      <Card className="grid gap-4 p-6">
        <OnboardingStepper />
      </Card>

      <section
        aria-labelledby="next-up-heading"
        className="grid gap-3 rounded-[var(--radius-lg)] border border-border bg-muted/40 p-6"
      >
        <h2 id="next-up-heading" className="font-display text-h3 tracking-tight text-foreground">
          What&apos;s next?
        </h2>
        <ul className="grid gap-2 text-body text-muted-foreground">
          <li>
            <span className="text-foreground">Connect a cloud account.</span> Cross-account posture,
            IAM drift, and SaaS misconfig become available the moment you finish step 3.
          </li>
          <li>
            <span className="text-foreground">{`Wire ${brand.name} into CI/CD.`}</span> A
            team-scoped or scan-scoped API key (step 2) lets your pipeline trigger scans on every
            merge and block PRs against Critical drift.
          </li>
          <li>
            <span className="text-foreground">Bring your team.</span> Invite an engineer, a security
            analyst, and an on-call — assignee routing lives on the finding row, not on your inbox.
          </li>
        </ul>
      </section>
    </main>
  );
}
