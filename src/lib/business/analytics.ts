// @polsia:user-owned — single insert helper for the trial funnel.
//
// Called from every fire-point (the POST event route + each server hook
// in trial.ts and /api/scan). All write paths are fire-and-forget so a
// transient DB blip never blocks the UX. Failures route through the
// shared structured-logger sink (emitErrorLogEvent) and are returned to
// the caller as a rejected promise — call sites are expected to
// `.catch(() => undefined)` rather than surface the error to the user.

import 'server-only';
import type { TrialFunnelStep } from '@/lib/contracts/analytics';
import { prisma } from '@/lib/db';
import { emitErrorLogEvent } from '@/lib/logging/logger';

export interface RecordTrialFunnelStepInput {
  step: TrialFunnelStep;
  anonymousId?: string | null;
  userId?: string | null;
  teamId?: string | null;
  // Cohort + experiment labels for A/B segmentation of the dashboard
  // nudge. Optional; when omitted the row's default cohort/experiment
  // (set in the schema) is "control"/"cloud_nudge_v0" which keeps all
  // existing funnel steps 1-4 groupable without a backfill.
  cohort?: string | null;
  experiment?: string | null;
}

// One Prisma insert. `anonymousId` is set only on step 1 (cookie-derived
// UUID); all other fields are scalar fks to the locked User / Team models
// (`@prisma/client` exposes them as plain ids, no Prisma @relation).
//
// `cohort` and `experiment` are only assigned to the call when supplied.
// Omitting them lets the column defaults ('control' / 'cloud_nudge_v0')
// apply — explicit `null` would store NULL and break the admin segmented
// read downstream.
export async function recordTrialFunnelStep(input: RecordTrialFunnelStepInput): Promise<void> {
  try {
    const data: {
      step: TrialFunnelStep;
      anonymousId: string | null;
      userId: string | null;
      teamId: string | null;
      createdAt: Date;
      cohort?: string;
      experiment?: string;
    } = {
      step: input.step,
      anonymousId: input.anonymousId ?? null,
      userId: input.userId ?? null,
      teamId: input.teamId ?? null,
      createdAt: new Date(),
    };
    if (input.cohort != null) data.cohort = input.cohort;
    if (input.experiment != null) data.experiment = input.experiment;

    await prisma.trialFunnelEvent.create({ data });
  } catch (err) {
    emitErrorLogEvent({
      ts: new Date().toISOString(),
      level: 'error',
      msg: 'analytics.funnel_write_failed',
      step: input.step,
      err:
        err instanceof Error
          ? { name: err.name, message: err.message }
          : { name: 'Error', message: 'unknown error' },
    });
    throw err;
  }
}
