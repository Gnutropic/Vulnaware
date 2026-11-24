// @polsia:user-owned — Trial-expiry banner mounted in global-mounts.
//
// On mount, fetches /api/trial-status. Returns null for non-authed
// callers (the endpoint 401s, which apiFetch turns into a thrown
// reject). Renders an Alert at the top of the viewport when the
// caller has an active trial that ends within 7 days, and a
// destructive alert when it has already ended. Refreshes every 60s
// + on window:focus so a long-open tab keeps accurate copy without
// a full reload.

'use client';

import { AlertTriangle, Clock } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { apiFetch } from '@/lib/api-client';
import { TrialStatus } from '@/lib/contracts/trial';

interface BannerCopy {
  title: string;
  body: string;
  variant: 'warning' | 'destructive';
}

function bannerCopy(daysRemaining: number | null): BannerCopy | null {
  if (daysRemaining == null) return null;
  if (daysRemaining <= 0) {
    return {
      title: 'Your trial has ended',
      body: 'Your workspace read-only window has begun. Upgrade to keep prioritizing your findings, connecting cloud accounts, and creating API keys.',
      variant: 'destructive',
    };
  }
  if (daysRemaining > 7) return null;
  if (daysRemaining === 1) {
    return {
      title: 'Your trial ends tomorrow',
      body: 'After tomorrow your workspace becomes read-only. Upgrade from the workspace to keep your findings ranked and integrations active.',
      variant: 'warning',
    };
  }
  return {
    title: `Your trial ends in ${daysRemaining} days`,
    body: 'Upgrade from your workspace to keep your findings ranked, cloud integrations live, and API keys operational.',
    variant: 'warning',
  };
}

export function TrialExpiryBanner() {
  const [status, setStatus] = useState<TrialStatus | null | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const result = await apiFetch('/api/trial-status', { schema: TrialStatus });
      setStatus(result);
    } catch {
      // Non-authed (401) or transient network error — render nothing.
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => {
      void load();
    }, 60_000);
    const onFocus = () => {
      void load();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);

  if (status === undefined) return null;
  if (!status || !status.active) return null;

  const copy = bannerCopy(status.daysRemaining);
  if (!copy) return null;

  const Icon = copy.variant === 'destructive' ? AlertTriangle : Clock;

  return (
    <Alert
      variant={copy.variant === 'destructive' ? 'destructive' : 'default'}
      role="status"
      aria-live="polite"
      className={
        copy.variant === 'destructive'
          ? 'mx-auto my-3 max-w-screen-xl'
          : 'mx-auto my-3 max-w-screen-xl border-brand-300 bg-brand-50 text-brand-900 dark:border-brand-700 dark:bg-brand-900/40 dark:text-brand-100'
      }
    >
      <Icon className="size-4" aria-hidden />
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription>{copy.body}</AlertDescription>
    </Alert>
  );
}
