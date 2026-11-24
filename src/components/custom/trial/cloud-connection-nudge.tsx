// @polsia:user-owned — targeted cloud-connection nudge (cloud_nudge_v1).
//
// Client island, mounted only on /dashboard. A/B-gated:
//   - `NEXT_PUBLIC_TRIAL_COHORT === 'nudge_v1'` → render the prompt
//   - `'control'` → render null (the entire feature is suppressed)
//
// Cohort is sticky per <userId> via localStorage so a returning visitor
// sees the same treatment across reloads. When the env is unset
// (dev/staging) the cohort is determined by hashing the userId so dev
// never shows a 100% nudge cohort.
//
// Visibility gate activates only on authed trial teams < 7 days old
// with no cloud connection yet — the exact drop-off window the funnel
// analysis flagged. Outside that window the island returns null.
//
// Two funnel writes happen against /api/analytics/events:
//   - `cloud_nudge_shown` once per (user, day) the nudge becomes
//     visible, fired-and-forget
//   - `cloud_nudge_clicked` once per (user, day) the CTA is invoked,
//     deduped the same way
//
// Both writes carry the resolved cohort/experiment so the admin read
// can split the funnel between nudge and control populations.

'use client';

import { Cloud } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/auth-client';
import { brand } from '@/lib/brand';
import { TrialFunnelEventIngestResponse, type TrialFunnelStep } from '@/lib/contracts/analytics';
import { TrialStatus as TrialStatusSchema, trialProgressResponse } from '@/lib/contracts/trial';
import { env } from '@/lib/env';

const COHORT_STORAGE_PREFIX = 'polsia_cloud_nudge_cohort';
const SHOWN_DEDUPE_PREFIX = 'polsia_cloud_nudge_shown';
const CLICK_DEDUPE_PREFIX = 'polsia_cloud_nudge_clicked';

const NUDGE_COALLOWED_BEFORE_CLICK = 0;
const MAX_TRIAL_AGE_DAYS = 7;

interface StatusData {
  active: boolean;
  trialEndsAt: string | null;
  daysRemaining: number | null;
  onboardingStep: number;
  onboardingCompleted: boolean;
}

interface ProgressData {
  scansCreated: number;
  apiKeysIssued: number;
  cloudConnectionsConnected: number;
  teammatesInvited: number;
}

function todayKey(now: Date): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Deterministic userId hash for the dev fallback cohort. LocalStorage
// may not contain a previously assigned cohort (fresh visitor, dev
// with no env), so we hash instead of randomising — otherwise dev
// would split 50/50 on every reload and the gate would never be
// observable.
function hashToCohort(userId: string): 'nudge_v1' | 'control' {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 2 === 0 ? 'control' : 'nudge_v1';
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // best-effort — dedupe becomes per-session in private mode; the
    // trade-off is a single extra row per session, never a UX issue.
  }
}

function fire(step: TrialFunnelStep, cohort: string, experiment: string): void {
  void apiFetch('/api/analytics/events', {
    method: 'POST',
    body: JSON.stringify({ step, cohort, experiment }),
    schema: TrialFunnelEventIngestResponse,
  }).catch(() => undefined);
}

export function CloudConnectionNudge(): ReactNode {
  const { data: session, isPending } = useSession();
  const userId = session?.user?.id ?? null;
  const [cohort, setCohort] = useState<'nudge_v1' | 'control' | null>(null);
  const experiment = env.NEXT_PUBLIC_TRIAL_EXPERIMENT ?? 'cloud_nudge_v0';
  const [visible, setVisible] = useState(false);
  const inFlight = useRef(false);

  // Cohort assignment: sticky per user, sourced either from the build
  // env (the production A/B switch) or from localStorage / a deterministic
  // hash fallback for dev.
  useEffect(() => {
    if (isPending) return;
    if (!userId) return;

    const storageKey = `${COHORT_STORAGE_PREFIX}:${userId}`;
    const stored = readStored(storageKey);
    if (stored === 'nudge_v1' || stored === 'control') {
      setCohort(stored);
      return;
    }
    const fromEnv = env.NEXT_PUBLIC_TRIAL_COHORT;
    const assigned: 'nudge_v1' | 'control' = fromEnv ?? hashToCohort(userId);
    writeStored(storageKey, assigned);
    setCohort(assigned);
  }, [isPending, userId]);

  const load = useCallback(async () => {
    if (!userId) return;
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const [status, progress] = await Promise.all([
        apiFetch('/api/trial-status', { schema: TrialStatusSchema }),
        apiFetch('/api/trial-progress', { schema: trialProgressResponse }),
      ]);
      const s = status as StatusData;
      const p = progress as ProgressData;
      const isVisible =
        s.active &&
        !s.onboardingCompleted &&
        p.cloudConnectionsConnected === NUDGE_COALLOWED_BEFORE_CLICK &&
        s.daysRemaining != null &&
        s.daysRemaining > 0 &&
        s.daysRemaining < MAX_TRIAL_AGE_DAYS;
      setVisible(isVisible);
    } catch {
      setVisible(false);
    } finally {
      inFlight.current = false;
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    void load();
    const onFocus = () => {
      void load();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [userId, load]);

  // Fire `cloud_nudge_shown` once per (user, day) the gate flips on.
  // Effect-only so reloads within a calendar day dedupe.
  useEffect(() => {
    if (!userId) return;
    if (cohort !== 'nudge_v1') return;
    if (!visible) return;
    const key = `${SHOWN_DEDUPE_PREFIX}:${userId}:${todayKey(new Date())}`;
    if (readStored(key) === '1') return;
    writeStored(key, '1');
    fire('cloud_nudge_shown', cohort, experiment);
  }, [userId, cohort, experiment, visible]);

  const onCtaClick = useCallback(() => {
    if (!userId || cohort !== 'nudge_v1') return;
    const key = `${CLICK_DEDUPE_PREFIX}:${userId}:${todayKey(new Date())}`;
    if (readStored(key) === '1') return;
    writeStored(key, '1');
    fire('cloud_nudge_clicked', cohort, experiment);
  }, [userId, cohort, experiment]);

  if (cohort !== 'nudge_v1' || !visible) return null;

  return (
    <aside
      aria-label="Trial nudge: connect a cloud account"
      className="grid grid-cols-[auto_1fr_auto] items-center gap-4 rounded-[var(--radius-lg)] border border-brand-300 bg-brand-50 px-5 py-4 shadow-sm dark:border-brand-700 dark:bg-brand-900/30"
    >
      <Cloud className="size-6 text-brand-600 dark:text-brand-300" aria-hidden />
      <div className="grid gap-1">
        <p className="text-eyebrow text-brand-700 dark:text-brand-200">Stuck? Unblock step 3.</p>
        <p className="font-display text-body-lg text-brand-900 dark:text-brand-50">
          Connect your first cloud account
        </p>
        <p className="text-caption text-brand-800/80 dark:text-brand-200/80">
          {`AWS, Azure, or GCP — once linked, ${brand.name} enumerates your live assets and unlocks the
          rest of the dashboard.`}
        </p>
      </div>
      <Button
        asChild
        size="default"
        variant="default"
        className="bg-brand-600 text-white hover:bg-brand-700 dark:bg-brand-400 dark:text-brand-950 dark:hover:bg-brand-300"
        onClick={onCtaClick}
      >
        <Link href="/cloud">Connect cloud account</Link>
      </Button>
    </aside>
  );
}
