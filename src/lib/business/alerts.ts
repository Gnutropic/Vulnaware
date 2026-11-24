// @polsia:user-owned — Per-team alert writer invoked by the live-rescore
// orchestrator. One row per KEV transition or fresh VulnCheck sighting;
// the create is fire-and-forget at the row level (`void createAlertForTeam(...).catch(() => {})`)
// so a transient DB blip on a single row never blocks a rescore.
//
// Decision rule (transition gate, NOT post-state):
//   - KEV: write iff `persisted.kevListed === false && r.kev != null`
//   - VulnCheck: write iff `persisted.vulncheckListed === false && r.vulncheck != null`
//
// `teamId` provenance: comes from `Scan.teamId`, NOT from any request context.
// If the scan is unattributed (legacy null teamId), the row is skipped — an alert
// with no team is invisible to every team and worse than a dropped write.
//
// `createAlertForTeam` is the SHARED creation seam: both the rescore path
// below and the admin `POST /api/alerts` back-door call it. Critical-severity
// writes fan out via `deliverCriticalNotification` so a Slack-compatible
// webhook (saved by a workspace admin on /settings/integrations/notifications)
// receives the same payload from both flows.
//
// Per-user webhook fan-out: every new alert (regardless of severity) ALSO
// fires `deliverNewAlertUserWebhooks` so a user who saved their own
// DevSecOps endpoint on /account receives the documented snake_case
// payload. The two flows are independent — the team Slack path and the
// per-user DevSecOps path live in parallel and share no state.

import 'server-only';
import { deliverNewAlertUserWebhooks } from '@/lib/business/account-webhook';
import { deliverCriticalNotification } from '@/lib/business/team-notifications';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

export interface AlertRescoreRow {
  findingId: string;
  scanId: string;
  severity: string | null;
  // True when the row has a fresh KEV entry on the rescored map. Truthiness
  // is what gates the transition; the actual shape is owned by kev.ts.
  kev: unknown;
  // Same — when non-null, this is a fresh VulnCheck sighting.
  vulncheck: { observedAt?: Date } | null;
}

export interface PersistedFindingState {
  kevListed: boolean;
  vulncheckListed: boolean;
}

export interface AppendAlertsContext {
  now: Date;
  // Snapshot of pre-rescore state. Outer scope looks this up and hands it
  // in so the helper is genuinely synchronous-ish (no second DB fetch for
  // every row).
  persistedMap: Map<string, PersistedFindingState>;
}

export interface CreateAlertParams {
  teamId: string;
  findingId: string;
  severity: string | null;
  source: 'kev' | 'vulncheck' | 'manual';
  title?: string | null;
  alertId?: string;
  createdAt?: Date;
}

export interface CreatedAlert {
  id: string;
  teamId: string;
  severity: string | null;
  title: string | null;
  link: string;
  delivered: boolean;
  deliveryStatus: number | null;
  deliveryError: string | null;
}

// Shared alert-creation seam. The rescore path and the manual
// `POST /api/alerts` admin back-door both call into here so the row insert
// and the Slack-compatible fan-out stay coherent.
//
// Returns the persisted row's id, a deep-link base (using the app URL from
// env), and the result of the outbound fan-out (a null `delivered` means
// the severity was below the `critical` threshold and no fan-out ran).
export async function createAlertForTeam(params: CreateAlertParams): Promise<CreatedAlert> {
  const row = await prisma.alert.create({
    data: {
      id: params.alertId,
      teamId: params.teamId,
      findingId: params.findingId,
      severity: params.severity,
      source: params.source,
      createdAt: params.createdAt ?? new Date(),
    },
  });
  const link = `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '')}/alerts/${row.id}`;
  // Per-user DevSecOps webhook fan-out — fires for EVERY new alert
  // regardless of severity. Runs BEFORE the `isCritical` early-return so a
  // non-critical alert still reaches the user-saved endpoint. Fire-and-
  // forget: the helper's `Promise.allSettled` + `AbortSignal.timeout`
  // cannot stall this seam, so the `.catch(() => {})` is belt-and-
  // suspenders for an unexpected thrown error inside the helper itself.
  void deliverNewAlertUserWebhooks({
    teamId: row.teamId,
    alertId: row.id,
    titleHint: params.title ?? null,
  }).catch(() => {});
  const isCritical = (params.severity ?? '').toLowerCase() === 'critical';
  if (!isCritical) {
    return {
      id: row.id,
      teamId: row.teamId,
      severity: row.severity,
      title: params.title ?? null,
      link,
      delivered: false,
      deliveryStatus: null,
      deliveryError: null,
    };
  }
  const delivery = await deliverCriticalNotification({
    teamId: row.teamId,
    alert: {
      alertId: row.id,
      title: params.title ?? row.id,
      severity: row.severity ?? 'critical',
      link,
    },
  });
  return {
    id: row.id,
    teamId: row.teamId,
    severity: row.severity,
    title: params.title ?? null,
    link,
    delivered: delivery.ok,
    deliveryStatus: delivery.status,
    deliveryError: delivery.error,
  };
}

export async function appendAlertsForBumps(
  rows: AlertRescoreRow[],
  ctx: AppendAlertsContext,
): Promise<void> {
  if (rows.length === 0) return;

  const scanIds = Array.from(new Set(rows.map((r) => r.scanId)));
  const scans = await prisma.scan.findMany({
    where: { id: { in: scanIds } },
    select: { id: true, teamId: true },
  });
  const teamByScan = new Map<string, string | null>();
  for (const s of scans) teamByScan.set(s.id, s.teamId);

  for (const r of rows) {
    const teamId = teamByScan.get(r.scanId);
    if (teamId == null) continue;
    const persisted = ctx.persistedMap.get(r.findingId);
    const previousKev = persisted?.kevListed ?? false;
    const previousVc = persisted?.vulncheckListed ?? false;

    // KEV transition.
    if (previousKev === false && r.kev != null) {
      void createAlertForTeam({
        teamId,
        findingId: r.findingId,
        severity: r.severity,
        source: 'kev',
        createdAt: ctx.now,
      }).catch(() => {});
    }

    // Fresh VulnCheck sighting.
    if (previousVc === false && r.vulncheck != null) {
      void createAlertForTeam({
        teamId,
        findingId: r.findingId,
        severity: r.severity,
        source: 'vulncheck',
        createdAt: ctx.now,
      }).catch(() => {});
    }
  }
}
