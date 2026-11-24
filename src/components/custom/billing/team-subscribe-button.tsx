// @polsia:user-owned
//
// 'use client' Team-plan Subscribe CTA — mounted by /pricing on the Team tier
// card. On click it POSTs to /api/billing/team-subscribe, gets back the hosted
// Stripe Checkout URL, and full-page navigates to it. Server-side pricing +
// error mapping per stripe-billing AGENT.md; this island never reads or shows
// the raw exception so the unconfigured / not-onboarded states get a typed
// message instead of a Stripe error string.
//
// Compose with the standard <Button> primitive so it inherits the same cva
// variants + sizes the other pricing branches already use; className lands
// on the button itself so callers can pass `shadow-brand`, `w-full`, etc.

'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type MouseEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import {
  type TeamSubscribeRequest,
  teamSubscribeRequestSchema,
  teamSubscribeResponseSchema,
} from '@/lib/contracts/billing';

export interface TeamSubscribeButtonProps {
  productId: TeamSubscribeRequest['productId'];
  label: string;
  size?: 'default' | 'sm' | 'lg';
  variant?: 'default' | 'outline' | 'secondary' | 'ghost';
  className?: string;
}

// Friendly messages per error code returned by /api/billing/team-subscribe.
// Owner-not-onboarded and "payments not enabled" are not app bugs — they
// describe the workspace setup state and route the buyer to contact sales.
const ERROR_MESSAGES: Record<string, string> = {
  payments_not_enabled: 'Checkout is coming soon. Please contact us to subscribe.',
  stripe_not_configured:
    "The workspace owner hasn't connected Stripe yet. Please contact us to subscribe.",
  stripe_not_onboarded:
    'The workspace owner is still setting up Stripe. Please contact us to subscribe.',
  stripe_billing_not_configured: 'Checkout is unavailable right now. Please try again shortly.',
  checkout_failed: "We couldn't start checkout. Please try again or contact support.",
};

const GENERIC_ERROR = "We couldn't start checkout. Please try again or contact support.";

export function TeamSubscribeButton({
  productId,
  label,
  size = 'lg',
  variant = 'default',
  className,
}: TeamSubscribeButtonProps) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const body = teamSubscribeRequestSchema.parse({ productId });
      const data = await apiFetch('/api/billing/team-subscribe', {
        method: 'POST',
        body: JSON.stringify(body),
        schema: teamSubscribeResponseSchema,
      });
      // Full-page nav to Stripe so the cross-origin redirect survives dev
      // tools and slow connections cleanly. router.push would race.
      window.location.assign(data.url);
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
