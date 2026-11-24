// @polsia:user-owned
//
// 'use client' polling island for /billing/success. The Server Component has
// already done a first verify on mount via /api/billing/success-verify; this
// island handles the case where Stripe's webhook-to-Polsia write hasn't
// landed yet (so binding === 'verification_failed' on first paint).
// 10 attempts × 1500ms (per stripe-payments SKILL §2). On
// `verified && binding === 'verified_and_bound'` we call router.refresh()
// so the Server Component re-renders its /account subtree with the now-
// resolved active-plan read.
//
// Transport: POSTs to the user-owned auth-gated wrapper at
// /api/billing/verify with JSON `{ sessionId }`. The legacy GET
// /api/stripe-billing/verify is intentionally NOT touched — it stays
// the public verify the locked stripe-billing module ships, in case
// any non-signed-in consumer (a future cron, a third-party webhook)
// wants to verify a session id without a session cookie.

'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { billingVerifyRequestSchema, billingVerifyResponseSchema } from '@/lib/contracts/billing';

export interface BillingVerificationPollerProps {
  sessionId: string;
  initialError?: string;
}

const MAX_ATTEMPTS = 10;
const POLL_INTERVAL_MS = 1500;

type PollerState = 'pending' | 'wrong_account' | 'unrecoverable' | 'exhausted';

export function BillingVerificationPoller({
  sessionId,
  initialError,
}: BillingVerificationPollerProps) {
  const router = useRouter();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PollerState>(
    initialError === 'stripe_billing_not_configured' ? 'unrecoverable' : 'pending',
  );
  const cancelled = useRef(false);

  const runPoll = useCallback(async () => {
    setAttempt(0);
    setState('pending');
    for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
      if (cancelled.current) return;
      setAttempt(i);
      try {
        const body = billingVerifyRequestSchema.parse({ sessionId });
        const result = await apiFetch('/api/billing/verify', {
          method: 'POST',
          body: JSON.stringify(body),
          schema: billingVerifyResponseSchema,
        });
        if (cancelled.current) return;
        if (result.binding === 'verified_and_bound') {
          router.refresh();
          return;
        }
        if (result.binding === 'verified_not_bound') {
          // The proxy verified a payment but the buyer isn't bound to
          // this account. Stop polling — more attempts won't bind them.
          setState('wrong_account');
          return;
        }
        // 'verification_failed' — keep polling until exhausted (the
        // Stripe webhook-to-Polsya write may still be in flight).
        if (result.error === 'stripe_billing_not_configured') {
          setState('unrecoverable');
          return;
        }
      } catch {
        if (cancelled.current) return;
        // network blip — keep polling until exhausted
      }
      if (i < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    }
    if (!cancelled.current) {
      setState('exhausted');
    }
  }, [router, sessionId]);

  useEffect(() => {
    cancelled.current = false;
    if (initialError === 'stripe_billing_not_configured') {
      setState('unrecoverable');
      return;
    }
    void runPoll();
    return () => {
      cancelled.current = true;
    };
  }, [initialError, runPoll]);

  if (state === 'pending') {
    return (
      <output
        aria-live="polite"
        className="flex items-center gap-3 rounded-md border border-border bg-card p-5 text-body text-muted-foreground"
      >
        <Loader2 className="size-5 animate-spin text-brand-500" aria-hidden />
        <p>{`Still verifying your subscription (attempt ${attempt} of ${MAX_ATTEMPTS})…`}</p>
      </output>
    );
  }

  if (state === 'wrong_account') {
    return (
      <div className="flex flex-col gap-4 rounded-md border border-border bg-card p-5 shadow-sm">
        <p className="text-body text-foreground">
          We verified this checkout session, but it wasn&apos;t paid for by the account you&apos;re
          signed in as. Sign in with the email you used at checkout, or contact support if you
          believe this is a mistake.
        </p>
        <Button asChild type="button" variant="outline">
          <a href="/signup">Switch account</a>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-md border border-border bg-card p-5 shadow-sm">
      <p className="text-body text-foreground">
        {state === 'unrecoverable'
          ? "We couldn't reach the billing service. Please refresh the page or contact us if the issue persists."
          : "Your payment is processing. Verification didn't complete in time — most payments clear within a minute."}
      </p>
      <Button
        type="button"
        variant="outline"
        onClick={() => void runPoll()}
        disabled={state === 'unrecoverable'}
      >
        Retry verification
      </Button>
    </div>
  );
}
