// @polsia:user-owned — Onboarding-stepper rendered on /trial/started.
//
// Server-rendered shell + client island. The server returns the static
// markup; the client reads /api/trial-progress + trial-status via
// apiFetch (the data-plane rule). It shows four checkpoints and ticks
// them off as the trialist progresses through the workspace:
//
//   1. Open a scan          → /api/trial-progress (scansCreated > 0)
//   2. Generate an API key  → /api/trial-progress (apiKeysIssued > 0)
//   3. Connect a cloud account → /api/trial-progress (awsCount+azureCount+gcpCount > 0)
//   4. Invite a teammate    → /api/trial-progress (members > 1)
//
// Plus the trial countdown (trialEndsAt from /api/trial-status), so the
// trialist sees how long the workspace has.

'use client';

import { CheckCircle2, Circle, Clock, Cloud, KeyRound, ScanSearch, Users } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { brand } from '@/lib/brand';
import { TrialStatus as TrialStatusSchema, trialProgressResponse } from '@/lib/contracts/trial';

interface ProgressData {
  scansCreated: number;
  apiKeysIssued: number;
  cloudConnectionsConnected: number;
  teammatesInvited: number;
}

interface StatusData {
  active: boolean;
  trialEndsAt: string | null;
  daysRemaining: number | null;
  onboardingStep: number;
  onboardingCompleted: boolean;
}

const STEPS = [
  {
    key: 'scan',
    title: 'Open a scan',
    body: 'Trigger a scan against the seeded sample host, or point it at your own surface.',
    icon: ScanSearch,
    cta: { label: 'Open scans', href: '/scans' },
  },
  {
    key: 'apikey',
    title: 'Generate an API key',
    body: `Create a team-scoped or scan-scoped key to wire ${brand.name} into your CI/CD.`,
    icon: KeyRound,
    cta: { label: 'Open API keys', href: '/settings/api-keys' },
  },
  {
    key: 'cloud',
    title: 'Connect a cloud account',
    body: `Add AWS, Azure, or GCP credentials and let ${brand.name} enumerate them.`,
    icon: Cloud,
    cta: { label: 'Open Cloud', href: '/cloud' },
  },
  {
    key: 'team',
    title: 'Invite a teammate',
    body: 'Bring in a colleague — engineer, security analyst, or on-call.',
    icon: Users,
    cta: { label: 'Open team', href: '/settings/team' },
  },
] as const;

function isStepComplete(key: keyof typeof STEP_COMPLETION_LOOKUP, data: ProgressData): boolean {
  switch (key) {
    case 'scan':
      return data.scansCreated > 0;
    case 'apikey':
      return data.apiKeysIssued > 0;
    case 'cloud':
      return data.cloudConnectionsConnected > 0;
    case 'team':
      return data.teammatesInvited > 0;
  }
}

const STEP_COMPLETION_LOOKUP = {
  scan: 'scansCreated',
  apikey: 'apiKeysIssued',
  cloud: 'cloudConnectionsConnected',
  team: 'teammatesInvited',
} as const;

export function OnboardingStepper() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [progress, setProgress] = useState<ProgressData | null>(null);

  const load = useCallback(async () => {
    try {
      const statusResult = await apiFetch('/api/trial-status', { schema: TrialStatusSchema });
      setStatus(statusResult);
    } catch {
      setStatus(null);
    }
    try {
      const progressResult = await apiFetch('/api/trial-progress', {
        schema: trialProgressResponse,
      });
      setProgress(progressResult);
    } catch {
      setProgress(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => {
      void load();
    }, 60_000);
    return () => window.clearInterval(interval);
  }, [load]);

  const remaining = status?.daysRemaining ?? null;
  const remainingLabel =
    remaining == null
      ? '—'
      : remaining <= 0
        ? 'Ended'
        : remaining === 1
          ? '1 day'
          : `${remaining} days`;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-xl)] border border-brand-300 bg-brand-50 px-5 py-4 dark:border-brand-700 dark:bg-brand-900/40">
        <div className="flex items-center gap-3 text-brand-900 dark:text-brand-100">
          <Clock className="size-5" aria-hidden />
          <div>
            <p className="font-display text-h3 tracking-tight">
              {remainingLabel}{' '}
              {remaining != null && remaining > 0 ? 'left in your trial' : 'remaining'}
            </p>
            <p className="text-caption text-brand-800/80 dark:text-brand-200/80">
              {status?.active
                ? 'Every action below counts toward onboarding.'
                : 'No active trial on this workspace yet.'}
            </p>
          </div>
        </div>
        <Badge variant="outline" className="border-brand-500 text-brand-700 dark:text-brand-200">
          Woo hoo — your sample data is live
        </Badge>
      </div>

      <ol className="grid gap-3">
        {STEPS.map((step, index) => {
          const done = progress ? isStepComplete(step.key, progress) : false;
          return (
            <li
              key={step.key}
              className="grid grid-cols-[auto_1fr_auto] gap-4 rounded-[var(--radius-lg)] border border-border bg-card px-5 py-4 shadow-sm"
            >
              {done ? (
                <CheckCircle2 className="mt-1 size-5 text-brand-500" aria-hidden />
              ) : (
                <Circle className="mt-1 size-5 text-muted-foreground/40" aria-hidden />
              )}
              <div className="grid gap-1">
                <p className="text-eyebrow text-muted-foreground">Step {index + 1}</p>
                <p className="font-display text-body-lg text-foreground">{step.title}</p>
                <p className="text-caption text-muted-foreground">{step.body}</p>
              </div>
              <Button asChild size="sm" variant={done ? 'outline' : 'secondary'}>
                <Link href={step.cta.href}>{step.cta.label}</Link>
              </Button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
