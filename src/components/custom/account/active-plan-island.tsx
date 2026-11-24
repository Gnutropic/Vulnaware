// @polsia:user-owned
//
// 'use client' Active-plan card on /account. Mounts
// `apiFetch('/api/account/active-plan')` once and renders one of four
// branches based on `plan` + `source`. Compose from the same primitives
// the legacy /account page used (Card, Badge, dl matrix) so the visible
// structure stays byte-equivalent to the prior reading path — the only
// difference is that the data now lives in /api/account/active-plan
// instead of a server-side read.
//
// Branches:
//   plan='pro' & source='local'  → Team card w/ ManageBillingIsland
//   plan='pro' & source='proxy'  → Team card w/ proxy-supplied <dl>
//   plan='starter' (any source)  → Starter upsell card
//   plan='enterprise'            → Enterprise confirmation card (local
//                                   row only — see Plan §"Enterprise")
//   plan='unknown'               → "Subscription unavailable"
//
// ! No DB / server-only imports — biome `noRestrictedImports` rejects
// them in `'use client'` files.

'use client';

import { AlertTriangle, Receipt, RefreshCw, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ManageBillingIsland } from '@/components/custom/billing/manage-billing-island';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-client';
import { brand } from '@/lib/brand';
import { type ActivePlanResponse, activePlanResponseSchema } from '@/lib/contracts/billing';
import { pricingTiers } from '@/lib/pricing-tiers';

export interface ActivePlanIslandProps {
  userEmail?: string | null;
}

function formatNextBilling(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function formatAmount(value: number | undefined): string {
  if (typeof value !== 'number') return '—';
  return `$${value.toFixed(2)} USD`;
}

const TEAM_TIER = pricingTiers.find((tier) => tier.slug === 'pro') ?? null;
const STARTER_TIER = pricingTiers.find((tier) => tier.slug === 'starter') ?? null;
const ENTERPRISE_TIER = pricingTiers.find((tier) => tier.slug === 'enterprise') ?? null;

export function ActivePlanIsland({ userEmail }: ActivePlanIslandProps) {
  const [result, setResult] = useState<ActivePlanResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const response = await apiFetch<unknown>('/api/account/active-plan');
      const data = activePlanResponseSchema.parse(response);
      setResult(data);
      setLoadError(null);
    } catch {
      // 401 / network / parse → leave `result` null so the loading
      // skeleton stays mounted OR the "Subscription unavailable"
      // card (depending on first vs subsequent render).
      setLoadError('We could not read your subscription. Please try again.');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void reload().finally(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  if (loadError && !result) {
    return (
      <Card className="border-border/80 bg-card shadow-sm">
        <CardHeader className="gap-3">
          <Badge variant="outline" className="w-fit gap-1.5 font-normal text-muted-foreground">
            <AlertTriangle className="size-3.5" aria-hidden />
            Subscription unavailable
          </Badge>
          <CardTitle className="font-display text-h2 tracking-tight text-foreground">
            We can&apos;t read your subscription right now.
          </CardTitle>
          <CardDescription className="text-body-lg text-muted-foreground">
            {`Something went wrong fetching your billing status. Try refreshing — if it keeps
            failing, contact ${brand.name} support.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button type="button" variant="outline" onClick={() => void reload()}>
            <RefreshCw className="size-4" aria-hidden /> Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!result) {
    return <ActivePlanSkeleton />;
  }

  // Team branch — when the local row is the source of truth, the
  // render is identical to the proxy branch except the user_email
  // / 月照片 / next-billing-date fields come from the row rather
  // than the proxy. Both branches share the body so a refactor
  // doesn't visually diverge.
  if (result.plan === 'pro') {
    const status = result.status;
    return (
      <Card className="border-border/80 bg-card shadow-md">
        <CardHeader className="gap-3">
          <Badge className="w-fit gap-1.5">
            <Receipt className="size-3.5" aria-hidden />
            Team plan
          </Badge>
          <p className="text-eyebrow text-brand-500">Your plan</p>
          <CardTitle className="font-display text-display tracking-tight text-foreground">
            You&apos;re on {TEAM_TIER?.name ?? 'Team'}.
          </CardTitle>
          <CardDescription className="text-body-lg text-muted-foreground">
            {`Manage payment method, invoices, or cancel from the Stripe portal. Changes reflect on
            this page after a refresh.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <dl className="grid gap-4 rounded-[var(--radius-lg)] border border-border bg-muted/30 p-5 sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <dt className="text-caption uppercase tracking-wider text-muted-foreground/80">
                Plan
              </dt>
              <dd className="font-display text-h4 text-foreground">
                {status?.plan ? status.plan : (TEAM_TIER?.name ?? 'Team')}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-caption uppercase tracking-wider text-muted-foreground/80">
                Amount
              </dt>
              <dd className="font-display text-h4 text-foreground">
                {formatAmount(status?.monthly_amount)}
              </dd>
              <dd className="text-small text-muted-foreground">per workspace / month</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-caption uppercase tracking-wider text-muted-foreground/80">
                Next billing date
              </dt>
              <dd className="font-display text-h4 text-foreground">
                {formatNextBilling(status?.current_period_end)}
              </dd>
            </div>
          </dl>

          <Separator />

          <div className="flex flex-col gap-2">
            <h2 className="font-display text-h4 tracking-tight text-foreground">Customer email</h2>
            <p className="font-mono text-body break-all text-foreground">
              {status?.customer_email ?? userEmail ?? '—'}
            </p>
          </div>

          <Separator />

          <ManageBillingIsland userEmail={status?.customer_email ?? userEmail ?? ''} />
        </CardContent>
      </Card>
    );
  }

  if (result.plan === 'enterprise') {
    // Local Enterprise row (this turn the only Enterprise write path
    // is the future `set-tier?enterprise` flow). Render an
    // acknowledgment card so /account shows the row write worked.
    return (
      <Card className="border-border/80 bg-card shadow-md">
        <CardHeader className="gap-3">
          <Badge className="w-fit gap-1.5">
            <Receipt className="size-3.5" aria-hidden />
            Enterprise plan
          </Badge>
          <p className="text-eyebrow text-brand-500">Your plan</p>
          <CardTitle className="font-display text-display tracking-tight text-foreground">
            You&apos;re on {ENTERPRISE_TIER?.name ?? 'Enterprise'}.
          </CardTitle>
          <CardDescription className="text-body-lg text-muted-foreground">
            {`Self-hosted control plane or single-tenant managed — your sales contact will reach
            out to finalize terms. Email us at ${brand.contactEmail} with any deal questions.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <Separator />
          <ManageBillingIsland userEmail={userEmail ?? ''} />
        </CardContent>
      </Card>
    );
  }

  if (result.plan === 'starter') {
    const teamFeatures = TEAM_TIER?.features ?? [];
    const previewFeatures = teamFeatures.slice(0, 6);
    return (
      <Card className="border-border/80 bg-card shadow-md">
        <CardHeader className="gap-3">
          <Badge variant="outline" className="w-fit gap-1.5 font-normal text-muted-foreground">
            <Sparkles className="size-3.5" aria-hidden />
            Starter plan
          </Badge>
          <p className="text-eyebrow text-brand-500">Your plan</p>
          <CardTitle className="font-display text-display tracking-tight text-foreground">
            You&apos;re on {STARTER_TIER?.name ?? 'Starter'}.
          </CardTitle>
          <CardDescription className="text-body-lg text-muted-foreground">
            {`Upgrade to ${TEAM_TIER?.name ?? 'Team'} to unlock prioritized remediation, multi-domain
            scanning, and full cloud-posture coverage across AWS, Azure, and GCP.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <ul className="grid gap-3 rounded-[var(--radius-lg)] border border-border bg-muted/30 p-5 sm:grid-cols-2">
            {previewFeatures.map((feature) => (
              <li key={feature} className="flex items-start gap-2 text-body text-foreground">
                <span
                  aria-hidden="true"
                  className="mt-2 inline-block size-1.5 shrink-0 rounded-full bg-brand-500"
                />
                <span>{feature}</span>
              </li>
            ))}
          </ul>

          <Separator />

          <div className="flex flex-wrap items-center gap-3">
            <Button asChild>
              <Link href="/pricing">See plans</Link>
            </Button>
            <Button asChild variant="outline">
              <a href={`mailto:${brand.contactEmail}`}>Talk to {brand.name}</a>
            </Button>
            <p className="font-mono text-caption text-muted-foreground/80">{userEmail ?? ''}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  // plan === 'unknown' — proxy read failed AND no local row. Show
  // the "Subscription unavailable" empty-state so the user can
  // retry before they escalate to support.
  return (
    <Card className="border-border/80 bg-card shadow-sm">
      <CardHeader className="gap-3">
        <Badge variant="outline" className="w-fit gap-1.5 font-normal text-muted-foreground">
          <AlertTriangle className="size-3.5" aria-hidden />
          Subscription unavailable
        </Badge>
        <CardTitle className="font-display text-h2 tracking-tight text-foreground">
          We can&apos;t read your subscription right now.
        </CardTitle>
        <CardDescription className="text-body-lg text-muted-foreground">
          {`Something went wrong fetching your billing status. Try refreshing — if it keeps
          failing, contact ${brand.name} support.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button type="button" variant="outline" onClick={() => void reload()}>
          <RefreshCw className="size-4" aria-hidden /> Retry
        </Button>
      </CardContent>
    </Card>
  );
}

function ActivePlanSkeleton() {
  return (
    <Card className="border-border/80 bg-card shadow-sm">
      <CardHeader className="gap-3">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-4 w-96" />
      </CardHeader>
      <CardContent className="grid gap-4">
        <Skeleton className="h-24 w-full rounded-[var(--radius-lg)]" />
        <Skeleton className="h-10 w-48" />
      </CardContent>
    </Card>
  );
}
