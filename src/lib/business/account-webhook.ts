// @polsia:user-owned — Per-user DevSecOps outbound webhook helper. One URL
// per user, an audit-loggable upsert, and a fan-out helper called by both
// the rescore cron lineage and the manual `POST /api/alerts` admin back-door
// inside `createAlertForTeam`.
//
// Failure posture:
//   - No retry queue. Fire-and-forget: the alert-create path wraps every
//     call in `.catch(() => {})`; the test handler reports its own outcome
//     inline.
//   - `server-only` import — never bundle with a client island.
//   - `AbortSignal.timeout(5000)` so a slow endpoint cannot stall
//     `createAlertForTeam`. `Promise.allSettled` so one dead endpoint
//     cannot abort the others.
//   - Every POST attempt writes a `UserWebhookDelivery` row (snippet =
//     `res.text().slice(0, 256)` on a response body, `err.message` on
//     fetch-throw / timeout, null if body empty). The 20-row ring buffer
//     is the per-attempt audit surface; no separate audit row is written
//     per attempt.

import 'server-only';
import { performance } from 'node:perf_hooks';
import { prisma } from '@/lib/db';

const DELIVERY_RING_DEPTH = 20;

// =================================================================
// Config CRUD
// =================================================================

export type UserWebhookConfigRow = {
  id: string;
  userId: string;
  webhookUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export interface UpsertUserUrlParams {
  userId: string;
  url: string | null;
}

export async function getUserWebhookConfig(userId: string): Promise<UserWebhookConfigRow | null> {
  return prisma.userWebhookConfig.findUnique({ where: { userId } });
}

export async function upsertUserWebhookUrl(
  params: UpsertUserUrlParams,
): Promise<UserWebhookConfigRow> {
  // UNIQUE(userId) lets us collapse existence into one call. NULL
  // `webhookUrl` is allowed so a PUT { url: null } wipes a saved endpoint
  // by overwriting the column.
  return prisma.userWebhookConfig.upsert({
    where: { userId: params.userId },
    create: {
      userId: params.userId,
      webhookUrl: params.url,
    },
    update: {
      webhookUrl: params.url,
    },
  });
}

// =================================================================
// Delivery ring buffer
// =================================================================

export type UserWebhookDeliveryRow = {
  id: string;
  userId: string;
  attemptedAt: Date;
  targetUrl: string;
  payloadKind: string;
  alertId: string | null;
  responseCode: number | null;
  latencyMs: number;
  snippet: string | null;
};

export interface RecordUserDeliveryParams {
  userId: string;
  targetUrl: string;
  payloadKind: 'alert' | 'test';
  alertId: string | null;
  responseCode: number | null;
  latencyMs: number;
  snippet: string | null;
}

export async function recordUserWebhookDelivery(params: RecordUserDeliveryParams): Promise<void> {
  await prisma.userWebhookDelivery.create({
    data: {
      userId: params.userId,
      targetUrl: params.targetUrl,
      payloadKind: params.payloadKind,
      alertId: params.alertId,
      responseCode: params.responseCode,
      latencyMs: params.latencyMs,
      snippet: params.snippet,
    },
  });
  await pruneUserDeliveryRing(params.userId, DELIVERY_RING_DEPTH);
}

async function pruneUserDeliveryRing(userId: string, keepLast: number): Promise<void> {
  const survivors = await prisma.userWebhookDelivery.findMany({
    where: { userId },
    orderBy: { attemptedAt: 'desc' },
    select: { id: true },
    take: keepLast,
  });
  const survivorIds = survivors.map((s) => s.id);
  if (survivorIds.length === 0) return;
  await prisma.userWebhookDelivery.deleteMany({
    where: { userId, id: { notIn: survivorIds } },
  });
}

export async function getUserWebhookDeliveries(
  userId: string,
  limit = DELIVERY_RING_DEPTH,
): Promise<UserWebhookDeliveryRow[]> {
  return prisma.userWebhookDelivery.findMany({
    where: { userId },
    orderBy: { attemptedAt: 'desc' },
    take: limit,
  });
}

// =================================================================
// Alert payload shape
// =================================================================

export interface AlertWebhookPayloadInput {
  alert: {
    id: string;
    severity: string | null;
    ownerId: string | null;
    createdAt: Date;
    // Caller-supplied title (mirrors the team Slack path's `params.title`).
    // May be null on a brand-new row; the helper falls back to cveId / alert
    // id so the wire always carries a meaningful identifier. Documented on
    // the <details> block on /account.
    title?: string | null;
  };
  finding: {
    cveId: string;
    // Asset is optional because a finding can exist in the import-test path
    // without a resolved asset row; emitting JSON `null` for `target` in
    // that case keeps the wire schema constant across all consumers.
    asset: { host: string; port: number; protocol: string } | null;
  };
  link: string;
}

function buildAlertPayload(input: AlertWebhookPayloadInput): Record<string, string | null> {
  // Title decision: brief requires `title` to always be present and never
  // null. Fall through `titleHint` → `finding.cveId` → `alert.id` so the
  // field always carries some meaningful identifier.
  const title = input.alert.title?.trim() || input.finding.cveId || input.alert.id;

  // Target decision: flatten `Asset.{host,port,protocol}` into
  // "host:port/protocol". Emit JSON `null` when no asset row exists so the
  // field count stays constant across wire consumers (a downstream
  // automation never has to conditionally check field presence).
  const target = input.finding.asset
    ? `${input.finding.asset.host}:${input.finding.asset.port}/${input.finding.asset.protocol}`
    : null;

  return {
    alert_id: input.alert.id,
    cve_id: input.finding.cveId,
    severity: input.alert.severity ?? 'unknown',
    title,
    target,
    url: input.link,
    owner_id: input.alert.ownerId,
    created_at: input.alert.createdAt.toISOString(),
  };
}

// =================================================================
// Fan-out helper (called by createAlertForTeam)
// =================================================================

export interface DeliverToUserWebhooksParams {
  teamId: string;
  alertId: string;
  titleHint?: string | null;
}

export interface DeliverToUserWebhooksResult {
  delivered: number;
  failed: number;
  skipped: number;
}

interface PostResult {
  responseCode: number | null;
  latencyMs: number;
  snippet: string | null;
}

async function postAndRecord(
  userId: string,
  url: string,
  body: Record<string, unknown>,
  meta: { payloadKind: 'alert' | 'test'; alertId: string | null },
): Promise<PostResult> {
  const result = await postWebhook(url, body);
  await recordUserWebhookDelivery({
    userId,
    targetUrl: url,
    payloadKind: meta.payloadKind,
    alertId: meta.alertId,
    responseCode: result.responseCode,
    latencyMs: result.latencyMs,
    snippet: result.snippet,
  });
  return result;
}

export async function deliverNewAlertUserWebhooks(
  params: DeliverToUserWebhooksParams,
): Promise<DeliverToUserWebhooksResult> {
  // Look up the affected team's members; only those members with a saved
  // webhook URL receive the payload. Membership.userId is the same scalar
  // FK the per-user config table references (no @relation by design — see
  // prisma/schema/membership.prisma for the locked-User rationale).
  const memberships = await prisma.membership.findMany({
    where: { teamId: params.teamId },
    select: { userId: true },
  });
  const userIds = Array.from(new Set(memberships.map((m) => m.userId)));
  if (userIds.length === 0) {
    return { delivered: 0, failed: 0, skipped: 0 };
  }

  const configs = await prisma.userWebhookConfig.findMany({
    where: { userId: { in: userIds }, NOT: { webhookUrl: null } },
    select: { userId: true, webhookUrl: true },
  });

  if (configs.length === 0) {
    const skipped = userIds.length;
    return { delivered: 0, failed: 0, skipped };
  }

  // Load the alert + its finding + CVE summary in one round-trip. The
  // finding/summary columns are nullable because a brand-new alert is
  // created BEFORE the daily-digest summary job runs the next cycle; the
  // payload helper falls back to cveId / alert.id so the wire always
  // carries a `title`.
  const alert = await prisma.alert.findUnique({
    where: { id: params.alertId },
    select: {
      id: true,
      severity: true,
      ownerId: true,
      createdAt: true,
      findingId: true,
    },
  });
  if (!alert) {
    return { delivered: 0, failed: 0, skipped: configs.length };
  }

  const finding = await prisma.vulnerabilityFinding.findUnique({
    where: { id: alert.findingId },
    select: {
      cveId: true,
      asset: { select: { host: true, port: true, protocol: true } },
    },
  });
  if (!finding) {
    return { delivered: 0, failed: 0, skipped: configs.length };
  }

  const link = `${process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '') ?? ''}/alerts/${alert.id}`;
  const payload = buildAlertPayload({
    alert: {
      id: alert.id,
      severity: alert.severity,
      ownerId: alert.ownerId,
      createdAt: alert.createdAt,
      title: params.titleHint ?? null,
    },
    finding: {
      cveId: finding.cveId,
      asset: finding.asset
        ? { host: finding.asset.host, port: finding.asset.port, protocol: finding.asset.protocol }
        : null,
    },
    link,
  });

  const results = await Promise.allSettled(
    configs.map((cfg) =>
      postAndRecord(cfg.userId, cfg.webhookUrl ?? '', payload, {
        payloadKind: 'alert',
        alertId: alert.id,
      }),
    ),
  );

  let delivered = 0;
  let failed = 0;
  for (const r of results) {
    if (
      r.status === 'fulfilled' &&
      r.value.responseCode != null &&
      r.value.responseCode >= 200 &&
      r.value.responseCode < 300
    ) {
      delivered++;
    } else {
      failed++;
    }
  }
  return { delivered, failed, skipped: 0 };
}

async function postWebhook(url: string, body: Record<string, unknown>): Promise<PostResult> {
  // AbortSignal.timeout caps a runaway endpoint at 5s; a slow destination
  // cannot stall the alert-create seam. Returns the structured deliver
  // result the caller writes to UserWebhookDelivery (responseCode +
  // latencyMs + snippet).
  const startedAt = performance.now();
  let responseCode: number | null = null;
  let snippet: string | null = null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    responseCode = res.status;
    const raw = await res.text();
    // Truncate to 256 chars so a noisy downstream never bloats the row.
    // Empty body → null so the UI distinguishes "delivered empty body"
    // from "no record at all".
    snippet = raw.length > 0 ? raw.slice(0, 256) : null;
  } catch (err) {
    snippet = err instanceof Error ? err.message : 'unknown fetch error';
  }
  const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
  return { responseCode, latencyMs, snippet };
}

// =================================================================
// Test send (manual; called by POST /api/account/webhook/test)
// =================================================================

export async function testUserWebhook(userId: string): Promise<{
  ok: boolean;
  status: number | null;
  latencyMs: number;
  error: string | null;
}> {
  // No-config branch records an "attempt" with `responseCode = null` and
  // `snippet = 'no webhook configured'` so the operator sees the
  // missing-config case in the deliveries list (mirrors
  // team-notifications.ts:218). The UI gets its no-config outcome through
  // the empty `cfg.url` on the GET, not through a button error.
  const config = await prisma.userWebhookConfig.findUnique({ where: { userId } });
  if (!config || !config.webhookUrl) {
    await recordUserWebhookDelivery({
      userId,
      targetUrl: '',
      payloadKind: 'test',
      alertId: null,
      responseCode: null,
      latencyMs: 0,
      snippet: 'no webhook configured',
    });
    return { ok: false, status: null, latencyMs: 0, error: 'no webhook configured' };
  }
  const startedAt = performance.now();
  let status: number | null = null;
  let snippet: string | null = null;
  let ok = false;
  try {
    const res = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ test: true }),
      signal: AbortSignal.timeout(5000),
    });
    status = res.status;
    ok = res.ok;
    const raw = await res.text();
    snippet = raw.length > 0 ? raw.slice(0, 256) : null;
    if (!ok && snippet === null) {
      snippet = `HTTP ${res.status}`;
    }
  } catch (err) {
    snippet = err instanceof Error ? err.message : 'unknown fetch error';
  }
  const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
  await recordUserWebhookDelivery({
    userId,
    targetUrl: config.webhookUrl,
    payloadKind: 'test',
    alertId: null,
    responseCode: status,
    latencyMs,
    snippet,
  });
  return { ok, status, latencyMs, error: ok ? null : (snippet ?? 'delivery failed') };
}
