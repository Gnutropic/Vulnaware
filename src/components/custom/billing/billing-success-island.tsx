// @polsia:user-owned
//
// 'use client' success-page island. Mounts the auth-gated
// /api/billing/success-verify POST → on `binding === 'verified_and_bound'`
// renders a tier-aware confirmation card (the same composition the legacy
// server-component used for the canonical verified state). On the other
// binding branches:
//   - 'verified_not_bound'    → "this session wasn't paid by your account"
//                              retry card (binding_reason: 'email_mismatch')
//   - 'verification_failed'   → the existing BillingVerificationPoller
//                              polling fallback; the typing on
//                              binding: 'verification_failed' is what
//                              tells the success-island to mount
//                              <BillingVerificationPoller/> rather than
//                              any of the success-card chrome.
//
// The page passes the `?tier=` URL param value as `initialTier` so the
// tier is known without a server-side read. `sessionId` comes from the
// success URL Stripe substitutes via `{CHECKOUT_SESSION_ID}`.
//
// ! No DB / server-only imports — biome `noRestrictedImports` rejects
// them in `'use client'` files.

'use client';

import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { BillingVerificationPoller } from '@/components/custom/billing/billing-verification-poller';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { apiFetch } from '@/lib/api-client';
import { brand } from '@/lib/brand';
import {
  type Binding,
  type SuccessVerifyResponse,
  successVerifyRequestSchema,
  successVerifyResponseSchema,
} from '@/lib/contracts/billing';
import type { PricingTierSlug } from '@/lib/pricing-tiers';

export interface BillingSuccessIslandProps {
  sessionId: string;
  initialError?: string | null;
  initialTier?: PricingTierSlug | null;
}

type IslandPhase =
  | { kind: 'loading'; error: string | null }
  | { kind: 'success'; result: SuccessVerifyResponse }
  | { kind: 'wrong_account'; sessionId: string }
  | { kind: 'pending'; sessionId: string; error: string | null };

export function BillingSuccessIsland({
  sessionId,
  initialError = null,
  initialTier = null,
}: BillingSuccessIslandProps) {
  const router = useRouter();
  const [phase, setPhase] = useState<IslandPhase>({
    kind: 'loading',
    error: initialError,
  });

  const runVerify = useCallback(async () => {
    try {
      const body = successVerifyRequestSchema.parse({
        sessionId,
        ...(initialTier ? { tier: initialTier } : {}),
      });
      const data = await apiFetch('/api/billing/success-verify', {
        method: 'POST',
        body: JSON.stringify(body),
        schema: successVerifyResponseSchema,
      });
      const binding: Binding = data.binding;
      if (binding === 'verified_and_bound') {
        setPhase({ kind: 'success', result: data });
        router.refresh();
        return;
      }
      if (binding === 'verified_not_bound') {
        setPhase({ kind: 'wrong_account', sessionId });
        return;
      }
      setPhase({ kind: 'pending', sessionId, error: data.error ?? null });
    } catch (err) {
      const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : null;
      const code =
        cause && typeof cause === 'object' && 'error' in cause
          ? String((cause as { error: unknown }).error)
          : '';
      setPhase({
        kind: 'pending',
        sessionId,
        error: code || 'verification_failed',
      });
    }
  }, [router, sessionId, initialTier]);

  useEffect(() => {
    void runVerify();
  }, [runVerify]);

  if (phase.kind === 'loading') {
    return (
      <Card className="border-border/80 bg-card shadow-sm">
        <CardHeader className="gap-3">
          <p className="text-eyebrow text-brand-500">Verifying…</p>
          <CardTitle className="font-display text-h2 tracking-tight">
            Confirming your subscription.
          </CardTitle>
          <CardDescription className="text-body-lg text-muted-foreground">
            {`We're checking Stripe's records to confirm your payment. This usually clears in
            a few seconds — keep this tab open.`}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (phase.kind === 'wrong_account') {
    return (
      <Card className="border-border/80 bg-card shadow-sm">
        <CardHeader className="gap-3">
          <Badge variant="outline" className="w-fit gap-1.5 font-normal text-muted-foreground">
            <AlertTriangle className="size-3.5" aria-hidden />
            Not your account
          </Badge>
          <p className="text-eyebrow text-brand-500">Subscription verification</p>
          <CardTitle className="font-display text-h2 tracking-tight text-foreground">
            This checkout didn&apos;t pay for the account you&apos;re signed in as.
          </CardTitle>
          <CardDescription className="text-body-lg text-muted-foreground">
            {`Stripe confirmed the payment, but the email used at checkout doesn't match your
            ${brand.name} account. Sign in with the email you used at checkout, or contact
            us if you believe this is a mistake.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button asChild variant="outline">
            <Link href="/pricing">Back to pricing</Link>
          </Button>
          <Button asChild>
            <Link href={`mailto:${brand.contactEmail}`}>Contact support</Link>
          </Button>
          <p className="w-full font-mono text-caption text-muted-foreground/80">
            Session ID: {sessionId}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (phase.kind === 'pending') {
    return (
      <Card className="border-border/80 bg-card shadow-sm">
        <CardHeader className="gap-3">
          <p className="text-eyebrow text-brand-500">Verifying…</p>
          <CardTitle className="font-display text-h2 tracking-tight">
            Confirming your subscription.
          </CardTitle>
          <CardDescription className="text-body-lg text-muted-foreground">
            {`We're polling Stripe's records to confirm your payment. This usually clears in a few
            seconds — keep this tab open.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BillingVerificationPoller
            sessionId={sessionId}
            initialError={phase.error ?? undefined}
          />
        </CardContent>
      </Card>
    );
  }

  // phase.kind === 'success'
  const payment = phase.result.payment;
  const plan =
    phase.result.plan === 'pro'
      ? 'pro'
      : phase.result.plan === 'enterprise'
        ? 'enterprise'
        : 'starter';

  return (
    <Card className="border-border/80 bg-card shadow-md">
      <CardHeader className="gap-3">
        <Badge className="w-fit gap-1.5">
          <CheckCircle2 className="size-3.5" aria-hidden />
          Subscription active
        </Badge>
        <CardTitle className="font-display text-display tracking-tight text-foreground">
          {titleForPlan(plan)}
        </CardTitle>
        <CardDescription className="text-body-lg text-muted-foreground">
          {descriptionForPlan(plan, brand.name)}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <dl className="grid gap-4 rounded-[var(--radius-lg)] border border-border bg-muted/30 p-5 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <dt className="text-caption uppercase tracking-wider text-muted-foreground/80">Plan</dt>
            <dd className="font-display text-h4 text-foreground">
              {payment?.product_name ?? labelForPlan(plan)}
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-caption uppercase tracking-wider text-muted-foreground/80">
              Amount
            </dt>
            <dd className="font-display text-h4 text-foreground">
              {payment && typeof payment.amount_usd === 'number'
                ? `$${payment.amount_usd.toFixed(2)} USD`
                : '—'}
            </dd>
            <dd className="text-small text-muted-foreground">
              {plan === 'pro' ? 'per workspace / month' : '—'}
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-caption uppercase tracking-wider text-muted-foreground/80">
              Customer email
            </dt>
            <dd className="font-display text-h4 break-all text-foreground">
              {payment?.customer_email ?? '—'}
            </dd>
          </div>
        </dl>

        <Separator />

        <div className="flex flex-wrap gap-3">
          <Button asChild>
            <Link href="/dashboard">Open the workspace</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/pricing">Back to pricing</Link>
          </Button>
        </div>
        <p className="text-small text-muted-foreground">
          Session ID: <span className="font-mono text-foreground">{sessionId}</span>
        </p>
      </CardContent>
    </Card>
  );
}

function titleForPlan(plan: 'starter' | 'pro' | 'enterprise'): string {
  switch (plan) {
    case 'pro':
      return "You're on Team.";
    case 'enterprise':
      return "You're on Enterprise.";
    default:
      return "You're on Starter.";
  }
}

function labelForPlan(plan: 'starter' | 'pro' | 'enterprise'): string {
  switch (plan) {
    case 'pro':
      return 'Team subscription';
    case 'enterprise':
      return 'Enterprise subscription';
    default:
      return 'Starter subscription';
  }
}
function descriptionForPlan(plan: 'starter' | 'pro' | 'enterprise', brandName: string): string {
  switch (plan) {
    case 'pro':
      return `Your ${brandName} Team subscription is verified. We've emailed a receipt and you
        can jump straight into the workspace.`;
    case 'enterprise':
      return `Your ${brandName} Enterprise subscription is set up. Our sales team will reach out
        to finalize MSA + DPA terms.`;
    default:
      return `Your ${brandName} Starter plan is active. Continue exploring the workspace —
        nothing else is needed.`;
  }
}
