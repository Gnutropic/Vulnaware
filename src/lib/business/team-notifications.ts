// @polsia:user-owned — Slack-compatible outbound webhook helper for critical
// alerts. One URL per team, an audit-loggable upsert, and a shared
// `deliverCriticalNotification()` fan-out helper used by both the rescore
// cron lineage and the manual `POST /api/alerts` admin back-door.
//
// Slack endpoints authenticate by URL secrecy, NOT by HMAC. The URL is stored
// plaintext (the platform encrypts at rest with the same envelope used for
// ApiKey.hash). We deliberately do NOT echo the URL through audit metadata
// so the audit log stays scrubbed of secrets.
//
// Failure posture:
//   - No retry queue. Fire-and-forget: the rescore path wraps every call in
//     `.catch(() => {})`; the test handler reports its own outcome inline.
//   - `server-only` import — never bundle with a client island.
//   - `performance.now()` stamps `latencyMs` (sub-ms resolution), so the
//     delivery-list can render a row even on fetch-throw or non-2xx.

import 'server-only';
import { performance } from 'node:perf_hooks';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

const DELIVERY_RING_DEPTH = 5;
const TEST_FIXTURE_ALERT_ID = 'test';

// =================================================================
// Config CRUD
// =================================================================

export type NotificationConfigRow = {
  id: string;
  teamId: string;
  webhookUrl: string;
  createdAt: Date;
  updatedAt: Date;
  createdByUserId: string | null;
};

export type NotificationDeliveryRow = {
  id: string;
  teamId: string;
  alertId: string | null;
  attemptedAt: Date;
  responseCode: number | null;
  latencyMs: number;
  errorMessage: string | null;
};

export interface UpsertUrlParams {
  teamId: string;
  url: string;
  actorUserId: string | null;
}

export async function upsertTeamNotificationUrl(
  params: UpsertUrlParams,
): Promise<NotificationConfigRow> {
  // UNIQUE(teamId) lets us collapse existence into one call.
  const row = await prisma.teamNotificationConfig.upsert({
    where: { teamId: params.teamId },
    create: {
      teamId: params.teamId,
      webhookUrl: params.url,
      createdByUserId: params.actorUserId,
    },
    update: {
      webhookUrl: params.url,
      createdByUserId: params.actorUserId,
    },
  });
  return row;
}

export async function getTeamNotificationConfig(
  teamId: string,
): Promise<NotificationConfigRow | null> {
  return prisma.teamNotificationConfig.findUnique({ where: { teamId } });
}

export async function getTeamNotificationDeliveries(
  teamId: string,
  limit = DELIVERY_RING_DEPTH,
): Promise<NotificationDeliveryRow[]> {
  return prisma.teamNotificationDelivery.findMany({
    where: { teamId },
    orderBy: { attemptedAt: 'desc' },
    take: limit,
  });
}

// Prune the ring buffer so only the most-recent `keepLast` rows survive.
// Done immediately after each insert. Low frequency (only critical alerts
// + tests), so the `deleteMany` is cheap enough to run unconditionally.
async function pruneDeliveryRing(teamId: string, keepLast: number): Promise<void> {
  const survivors = await prisma.teamNotificationDelivery.findMany({
    where: { teamId },
    orderBy: { attemptedAt: 'desc' },
    select: { id: true },
    take: keepLast,
  });
  const survivorIds = survivors.map((s) => s.id);
  if (survivorIds.length === 0) return;
  await prisma.teamNotificationDelivery.deleteMany({
    where: { teamId, id: { notIn: survivorIds } },
  });
}

// =================================================================
// Shared payload shape
// =================================================================

export interface NotificationPayloadInput {
  alertId: string;
  title: string;
  severity: string;
  link: string;
}

function buildPayload(input: NotificationPayloadInput): Record<string, string> {
  // Slack-compatible contract: top-level primitive fields. Slack's webhook
  // transformers read from `text` first then fall through to `attachments`;
  // we set both so a downstream transformer that prefers one or the other
  // still gets a useful string.
  return {
    alertId: input.alertId,
    title: input.title,
    severity: input.severity,
    link: input.link,
    text: `[${input.severity}] ${input.title} — ${input.link}`,
  };
}

// Jira-issue-shaped payload for the "Create ticket" action — POSTed from
// `src/app/api/alerts/[id]/ticket/route.ts` when an operator clicks the
// "Open as Jira ticket" button. Same destination as the Slack-shaped
// `buildPayload()` (the team's saved webhook URL); the consumer is the
// customer's downstream Jira automation that translates this JSON into a
// created issue.
//
// We also keep the flat `alertId`/`severity`/`link` fields on the same
// payload so a Slack-shaped transformer remains useful even when Jira
// doesn't pick up the `summary`/`description`/`labels` trio.
export interface JiraPayloadInput {
  alertId: string;
  cveId: string;
  severity: string;
  title: string;
  description: string;
  asset: { host: string; ip: string; port: number; protocol: string };
  link: string;
}

export function buildJiraPayload(input: JiraPayloadInput): Record<string, unknown> {
  // Fallback to the CVE id when the alert title is empty — Jira refuses an
  // empty `summary`. Pulling the body through markdown keeps the deep link
  // and asset row aligned with what the operator saw on the dashboard.
  const summary = input.title.length > 0 ? input.title : input.cveId;
  const description = [
    `**${input.cveId}** — severity: \`${input.severity}\``,
    '',
    input.description,
    '',
    `**Asset**: ${input.asset.host} (${input.asset.ip}:${input.asset.port}/${input.asset.protocol})`,
    '',
    `**Open in dashboard**: ${input.link}`,
  ].join('\n');
  return {
    summary,
    description,
    labels: ['security', input.severity.toLowerCase(), 'vuln-aware'],
    // Flat aliases — mirrors the Slack-shape fields so a dual-shape consumer
    // still surfaces useful text.
    alertId: input.alertId,
    cveId: input.cveId,
    severity: input.severity,
    link: input.link,
  };
}

function buildLinkFromBase(alertId: string, base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return `${trimmed}/alerts/${alertId}`;
}

// =================================================================
// Fan-out helper (called by the rescore AND by POST /api/alerts)
// =================================================================

export interface DeliverCriticalParams {
  teamId: string;
  alert: { alertId: string; title: string; severity: string; link: string };
  // Optional pre-shaped body. When omitted the helper POSTs the Slack-
  // compatible `buildPayload(alert)` shape — the default that the test
  // send and the high-pipeline rescore path still rely on. The
  // "Open as Jira ticket" handler passes a Jira-shaped JSON so the same
  // ring-buffer delivery row records both flows on /settings/integrations/
  // notifications.
  payload?: Record<string, unknown>;
}

export interface DeliverResult {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  error: string | null;
}

export async function deliverCriticalNotification(
  params: DeliverCriticalParams,
): Promise<DeliverResult> {
  const config = await prisma.teamNotificationConfig.findUnique({
    where: { teamId: params.teamId },
  });
  const startedAt = performance.now();
  if (!config) {
    // No config — record an "attempt" so the operator sees the missing-config
    // case in the deliveries list and reuses the same shape for both flows.
    await prisma.teamNotificationDelivery.create({
      data: {
        teamId: params.teamId,
        alertId: params.alert.alertId,
        attemptedAt: new Date(),
        responseCode: null,
        latencyMs: 0,
        errorMessage: 'no webhook configured',
      },
    });
    await pruneDeliveryRing(params.teamId, DELIVERY_RING_DEPTH);
    return { ok: false, status: null, latencyMs: 0, error: 'no webhook configured' };
  }

  const payload = params.payload ?? buildPayload(params.alert);
  let status: number | null = null;
  let error: string | null = null;
  let ok = false;
  try {
    const res = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    status = res.status;
    ok = res.ok;
    if (!ok) {
      error = `HTTP ${res.status}`;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : 'unknown fetch error';
  }
  const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
  await prisma.teamNotificationDelivery.create({
    data: {
      teamId: params.teamId,
      alertId: params.alert.alertId,
      attemptedAt: new Date(),
      responseCode: status,
      latencyMs,
      errorMessage: error,
    },
  });
  await pruneDeliveryRing(params.teamId, DELIVERY_RING_DEPTH);
  return { ok, status, latencyMs, error };
}

// =================================================================
// Test send (manual; called by POST /api/team/notifications/test)
// =================================================================

export type TestOutcome =
  | { ok: true; status: number; latencyMs: number; error: null }
  | { ok: false; status: number | null; latencyMs: number; error: string };

export async function testTeamNotification(teamId: string): Promise<TestOutcome> {
  const config = await prisma.teamNotificationConfig.findUnique({
    where: { teamId },
  });
  if (!config) {
    return { ok: false, status: null, latencyMs: 0, error: 'no webhook configured' };
  }
  const link = buildLinkFromBase(TEST_FIXTURE_ALERT_ID, env.NEXT_PUBLIC_APP_URL);
  const result = await deliverCriticalNotification({
    teamId,
    alert: {
      alertId: TEST_FIXTURE_ALERT_ID,
      title: 'Test alert',
      severity: 'critical',
      link,
    },
  });
  if (result.ok && result.status != null) {
    return { ok: true, status: result.status, latencyMs: result.latencyMs, error: null };
  }
  return {
    ok: false,
    status: result.status,
    latencyMs: result.latencyMs,
    error: result.error ?? 'delivery failed',
  };
}
