// @polsia:user-owned — Trial onboarding checklist card pinned to /dashboard.
//
// Returns null for any of:
//   - while session is loading
//   - while the first /api/onboarding-checklist read is in flight
//   - once all four steps are complete (card auto-hides)
//   - once the user has dismissed the card (stamp on TrialWorkspace)
//
// The 4-step list mirrors the welcome surface on /trial/started but is
// intentionally different copy + CTAs so each surface is self-contained.
// Steps render from the server-supplied array verbatim — copy is never
// re-authored client-side. Polling cadence matches cloud-connection-nudge:
// mount → 60s setInterval + window.focus refresh, so completing a step
// anywhere in the app surfaces here within a minute.
//
// Dismiss is optimistic: flips local state immediately so the row
// disappears without waiting for the round trip; if the POST fails,
// surfaces an inline error and restores the card.

'use client';

import { CheckCircle2, Cloud, FileSearch, Search, UserPlus, X } from 'lucide-react';
import Link from 'next/link';
import {
  type ComponentType,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/auth-client';
import {
  OnboardingChecklistResponse,
  OnboardingDismissResponse,
  type OnboardingStep,
  type OnboardingStepKey,
} from '@/lib/contracts/trial';

const ICONS: Record<
  OnboardingStepKey,
  ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
> = {
  connect_first_asset: Cloud,
  run_first_scan: Search,
  review_findings: FileSearch,
  invite_teammate: UserPlus,
};

interface ChecklistData {
  steps: OnboardingStep[];
  completed: boolean;
  dismissed: boolean;
}

export function OnboardingChecklistCard(): ReactNode {
  const { isPending } = useSession();
  const [data, setData] = useState<ChecklistData | null>(null);
  // Optimistic dismiss — flips to true before the server round trip
  // resolves so the card disappears immediately. Restored to false
  // only if the POST fails and the user clicks "Retry".
  const [optimisticDismissed, setOptimisticDismissed] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const [dismissInFlight, setDismissInFlight] = useState(false);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await apiFetch('/api/onboarding-checklist', {
        schema: OnboardingChecklistResponse,
      });
      setData(result);
    } catch {
      // Mis-shape / network failure → keep prior data so a transient
      // hide-then-reappear isn't visible on the dashboard.
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => {
      void load();
    }, 60_000);
    const onFocus = () => {
      void load();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);

  const onDismiss = useCallback(async () => {
    if (dismissInFlight) return;
    setDismissError(null);
    setDismissInFlight(true);
    setOptimisticDismissed(true);
    try {
      await apiFetch('/api/onboarding-checklist', {
        method: 'POST',
        schema: OnboardingDismissResponse,
      });
      // The next /api/onboarding-checklist poll will mirror the same
      // state; no need to set data here. Optimistic update keeps the
      // UX snappy on a slow connection.
    } catch {
      setOptimisticDismissed(false);
      setDismissError("Couldn't save — click retry to dismiss.");
    } finally {
      setDismissInFlight(false);
    }
  }, [dismissInFlight]);

  if (isPending) return null;
  if (!data) return null;
  if (data.completed || data.dismissed || optimisticDismissed) return null;

  const completedCount = data.steps.filter((s) => s.complete).length;
  const totalSteps = data.steps.length;

  return (
    <aside
      aria-label="Trial onboarding checklist"
      className="grid gap-4 rounded-[var(--radius-lg)] border border-brand-300 bg-brand-50 px-5 py-4 shadow-sm dark:border-brand-700 dark:bg-brand-900/30"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="grid gap-1">
          <p className="text-eyebrow text-brand-700 dark:text-brand-200">
            Get the most out of your trial
          </p>
          <p className="font-display text-body-lg text-brand-900 dark:text-brand-50">
            {`${completedCount} of ${totalSteps} complete`}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void onDismiss()}
          disabled={dismissInFlight}
          className="text-brand-700 hover:bg-brand-100 dark:text-brand-200 dark:hover:bg-brand-800/40"
        >
          <X className="mr-1 size-4" aria-hidden />
          Dismiss
        </Button>
      </header>

      <ol className="grid gap-2">
        {data.steps.map((step, index) => {
          const StepIcon = ICONS[step.key];
          return (
            <li
              key={step.key}
              className="grid grid-cols-[auto_auto_1fr_auto] items-center gap-4 rounded-[var(--radius-md)] border border-brand-200/70 bg-card/80 px-4 py-3 dark:border-brand-700/60 dark:bg-card/40"
            >
              <span className="grid size-9 place-items-center rounded-[var(--radius-md)] bg-brand-100 text-brand-600 dark:bg-brand-800/40 dark:text-brand-300">
                <StepIcon className="size-4" aria-hidden />
              </span>
              {step.complete ? (
                <CheckCircle2 className="size-5 text-brand-500" aria-label="Complete" />
              ) : (
                <Badge variant="outline" className="text-caption">
                  {`${index + 1} of ${totalSteps}`}
                </Badge>
              )}
              <div className="grid gap-1">
                <p className="font-display text-body font-medium text-foreground">{step.title}</p>
                <p className="text-caption text-muted-foreground">{step.body}</p>
              </div>
              <Button
                asChild
                size="sm"
                variant={step.complete ? 'outline' : 'default'}
                className={
                  step.complete
                    ? undefined
                    : 'bg-brand-600 text-white hover:bg-brand-700 dark:bg-brand-400 dark:text-brand-950 dark:hover:bg-brand-300'
                }
              >
                <Link href={step.ctaHref}>{step.ctaLabel}</Link>
              </Button>
            </li>
          );
        })}
      </ol>

      {dismissError ? (
        <output
          aria-live="polite"
          className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-destructive/40 bg-destructive/5 px-3 py-2 text-caption text-destructive"
        >
          <span>{dismissError}</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void onDismiss()}
            disabled={dismissInFlight}
          >
            Retry
          </Button>
        </output>
      ) : null}

      {/* Screen-reader progress announcement — keeps the layout flat
          and lets assistive tech catch the completion count. */}
      <p className="sr-only">
        {`Trial onboarding: ${completedCount} of ${totalSteps} steps complete.`}
      </p>
    </aside>
  );
}
