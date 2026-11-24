// @polsia:user-owned
//
// 'use client' per-tier Subscribe CTA — mounted by /pricing on each
// tier card. On click it POSTs `{ tier }` to /api/billing/tier-subscribe
// and branches on the response `kind`:
//
//   - 'stripe' → window.location.assign to the hosted Stripe URL.
//   - 'free'   → toast + router.push to /dashboard (Starter was just activated).
//   - 'contact'→ window.location.assign to the contact form URL.
//
// Server-side pricing + error mapping per stripe-billing AGENT.md;
// this island never reads or shows a raw exception so the unconfigured
// / not-onboarded states get a typed message instead of a Stripe error
// string. Mirrors the shape of the legacy TeamSubscribeButton so the
// existing /pricing card composition is a one-line swap.
//
// ! No DB / server-only imports — biome `noRestrictedImports` rejects
// them in `'use client'` files (the deploy build gate greps them too).

'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type MouseEvent, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import {
  type TierSubscribeResponse,
  tierSubscribeRequestSchema,
  tierSubscribeResponseSchema,
} from '@/lib/contracts/billing';
import type { PricingTierSlug } from '@/lib/pricing-tiers';

export interface TierSubscribeButtonProps {
  tier: PricingTierSlug;
  label: string;
  size?: 'default' | 'sm' | 'lg';
  variant?: 'default' | 'outline' | 'secondary' | 'ghost';
  className?: string;
}

// Friendly messages per error code returned by /api/billing/tier-subscribe.
// Owner-not-onboarded and "payments not enabled" are not app bugs — they
// describe the workspace setup state and route the buyer to contact sales.
// The two new codes (`invalid_tier`, `tier_unavailable`) cover the per-tier
// catalog: a typo'd slug or a future catalog hole shouldn't surface a
// Stripe error string.
const ERROR_MESSAGES: Record<string, string> = {
  payments_not_enabled: 'Checkout is coming soon. Please contact us to subscribe.',
  stripe_not_configured:
    "The workspace owner hasn't connected Stripe yet. Please contact us to subscribe.",
  stripe_not_onboarded:
    'The workspace owner is still setting up Stripe. Please contact us to subscribe.',
  stripe_billing_not_configured: 'Checkout is unavailable right now. Please try again shortly.',
  checkout_failed: "We couldn't start checkout. Please try again or contact support.",
  invalid_tier: 'This plan is unavailable right now. Please pick another tier or contact us.',
  tier_unavailable: 'This plan is unavailable right now. Please pick another tier or contact us.',
  invalid_request: 'We could not start checkout. Please refresh and try again.',
  free_write_failed: "We couldn't activate the Starter plan. Please try again or contact support.",
  unauthorized: "You'll need to sign in (or create an account) to start the Starter plan.",
};

const GENERIC_ERROR = "We couldn't start checkout. Please try again or contact support.";

export function TierSubscribeButton({
  tier,
  label,
  size = 'lg',
  variant = 'default',
  className,
}: TierSubscribeButtonProps) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const body = tierSubscribeRequestSchema.parse({ tier });
      const data: TierSubscribeResponse = await apiFetch('/api/billing/tier-subscribe', {
        method: 'POST',
        body: JSON.stringify(body),
        schema: tierSubscribeResponseSchema,
      });
      if (data.kind === 'stripe') {
        window.location.assign(data.url);
        return;
      }
      if (data.kind === 'free') {
        toast.success('Starter plan activated');
        router.push(data.redirect);
        return;
      }
      if (data.kind === 'binding_required') {
        // Anonymous Pro click → sign in first, then land back on
        // /pricing?tier=pro so the buyer resumes the upgrade flow
        // without losing intent.
        toast.info('Sign in to finish subscribing');
        window.location.assign(data.redirect);
        return;
      }
      // 'contact' (Enterprise) — full-page nav so the deep-link
      // replaces history cleanly across the in-app → "/contact"
      // transition.
      window.location.assign(data.redirect);
    } catch (err) {
      const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : null;
      const code =
        cause && typeof cause === 'object' && 'error' in cause
          ? String((cause as { error: unknown }).error)
          : '';
      setError(ERROR_MESSAGES[code] ?? GENERIC_ERROR);
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <span className="flex w-full flex-col">
      <Button
        type="button"
        onClick={handleClick}
        disabled={submitting}
        aria-busy={submitting}
        size={size}
        variant={variant}
        className={className ?? 'w-full'}
      >
        {submitting ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden /> Opening checkout…
          </>
        ) : (
          label
        )}
      </Button>
      {error ? (
        <p role="alert" className="mt-3 text-caption text-destructive">
          {error}
        </p>
      ) : null}
    </span>
  );
}
