// @polsia:user-owned
//
// 'use client' island mounted on /account for Team subscribers. Two affordances:
//   1) "Manage billing in Stripe" — POSTs /api/billing/team-cancel and gets
//      back a Stripe-hosted portal URL. The portal IS the cancel UI per
//      stripe-payments SKILL §"Subscriptions": do NOT build an inbound cancel
//      hook — Stripe-hosted portal pages do the work.
//   2) "Refresh status" — used after the user comes back from Stripe checkout
//      (a Starter who just paid flips to Team) to re-render the server read.
//      Implemented as `router.refresh()` so the Server Component's
//      `getSubscriptionStatus` call re-runs on the next paint.
//
// Error mapping mirrors team-subscribe-button.tsx so messaging stays
// consistent across both billing endpoints; one new code (`portal_unavailable`)
// signals that the platform hasn't shipped a billing-portal surface yet and
// the island falls back to a clear copy rather than a Stripe error string.

'use client';

import { Loader2, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { teamCancelRequestSchema, teamCancelResponseSchema } from '@/lib/contracts/billing';

export interface ManageBillingIslandProps {
  userEmail: string;
}

const ERROR_MESSAGES: Record<string, string> = {
  payments_not_enabled: 'Billing is coming soon. Please contact us to manage your subscription.',
  stripe_not_configured:
    "The workspace owner hasn't connected Stripe yet. Please contact us to manage your subscription.",
  stripe_not_onboarded:
    'The workspace owner is still setting up Stripe. Please contact us to manage your subscription.',
  stripe_billing_not_configured: 'Billing is unavailable right now. Please try again shortly.',
  portal_unavailable:
    'The customer billing portal is not available yet. Please contact us to manage your subscription.',
  email_required: 'Your account is missing an email address — please contact support.',
  unauthorized: 'Please sign in again to manage your subscription.',
  portal_failed: "We couldn't open the billing portal. Please try again or contact support.",
};

const GENERIC_ERROR = "We couldn't open the billing portal. Please try again or contact support.";

export function ManageBillingIsland({ userEmail }: ManageBillingIslandProps) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleManageBilling() {
    setError(null);
    setOpening(true);
    try {
      const body = teamCancelRequestSchema.parse({});
      const data = await apiFetch('/api/billing/team-cancel', {
        method: 'POST',
        body: JSON.stringify(body),
        schema: teamCancelResponseSchema,
      });
      // Full-page nav so the cross-origin redirect to Stripe survives dev
      // tools and slow networks cleanly. router.push races.
      window.location.assign(data.url);
    } catch (err) {
      const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : null;
      const code =
        cause && typeof cause === 'object' && 'error' in cause
          ? String((cause as { error: unknown }).error)
          : '';
      setError(ERROR_MESSAGES[code] ?? GENERIC_ERROR);
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-small text-muted-foreground">
        Manage payment method, download invoices, or cancel from the Stripe portal. After changes,
        refresh this page to see your updated plan here.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={handleManageBilling}
          disabled={opening}
          aria-busy={opening}
        >
          {opening ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden /> Opening portal…
            </>
          ) : (
            'Manage billing in Stripe'
          )}
        </Button>
        <RefreshStatusButton />
      </div>
      {error ? (
        <p role="alert" className="text-caption text-destructive">
          {error}
        </p>
      ) : null}
      <p className="font-mono text-caption text-muted-foreground/80">{userEmail}</p>
    </div>
  );
}

function RefreshStatusButton() {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);

  function handleRefresh() {
    setRefreshing(true);
    // Server Component re-runs getSubscriptionStatus on refresh — covers the
    // Starter → Team case where the user just paid at Stripe and the proxy
    // hasn't surfaced to the read yet.
    router.refresh();
    // Reset local spinner after the navigation settles — Next's transition
    // doesn't expose a stable callback, so a short timer prevents a stuck
    // disabled state if the refresh completes synchronously.
    setTimeout(() => setRefreshing(false), 500);
  }

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={handleRefresh}
      disabled={refreshing}
      aria-busy={refreshing}
    >
      {refreshing ? (
        <>
          <Loader2 className="size-4 animate-spin" aria-hidden /> Refreshing…
        </>
      ) : (
        <>
          <RefreshCw className="size-4" aria-hidden /> Refresh status
        </>
      )}
    </Button>
  );
}
