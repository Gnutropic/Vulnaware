// @polsia:user-owned — Wire contracts for /api/team/notifications/** and the
// admin POST to /api/alerts. Mirrors src/lib/contracts/webhooks.ts style: pure
// zod, NO server-only/db imports so both the server route handler and the
// client islands can `apiFetch({ schema })` and share a single source of truth.
//
// No `signingAlgorithm` here: Slack-compatible endpoints authenticate by URL
// secrecy, not HMAC. The wire shape stores the URL as ops paste it; the
// handler never echoes the URL through audit metadata so the audit log stays
// scrubbed of secrets.

import { z } from 'zod';

// Single-row read shape returned by GET /api/team/notifications.config.
// `createdAt`/`updatedAt` are ISO-8601 strings (UTC ms serialized).
export const NotificationConfigItem = z.object({
  id: z.string(),
  teamId: z.string(),
  webhookUrl: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdByUserId: z.string().nullable(),
});
export type NotificationConfigItem = z.infer<typeof NotificationConfigItem>;

// POST /api/team/notifications body — upsert the team's Slack-compatible URL.
// `url.max(2048)` matches the webhook contract so the same Slack-share-style
// URL fits. `url.url()` softens the validator so customers may use internal
// HTTPS endpoints without surprise `.url()` rejections in CI.
export const NotificationSetBody = z.object({
  url: z.string().url().max(2048),
});
export type NotificationSetBody = z.infer<typeof NotificationSetBody>;
export type NotificationSetBodyInput = z.input<typeof NotificationSetBody>;

// One row of the 5-deep delivery ring buffer for the page. `responseCode`
// is null when the request threw (DNS / TCP / TLS / fetch escaped);
// `errorMessage` is null on a 2xx response. `latencyMs` is always set so
// the UI can render a row even when the call failed mid-flight.
export const NotificationDeliveryItem = z.object({
  id: z.string(),
  alertId: z.string().nullable(),
  attemptedAt: z.string(),
  responseCode: z.number().int().nullable(),
  latencyMs: z.number().int(),
  errorMessage: z.string().nullable(),
});
export type NotificationDeliveryItem = z.infer<typeof NotificationDeliveryItem>;

// GET response — config (may be null when the team has no webhook saved yet)
// + last 5 delivery attempts in attemptedAt-desc order. Single round-trip so
// the page can mount without thrashing the data plane.
export const NotificationGetResponse = z.object({
  config: NotificationConfigItem.nullable(),
  deliveries: z.array(NotificationDeliveryItem),
});
export type NotificationGetResponse = z.infer<typeof NotificationGetResponse>;

// POST /api/team/notifications/test response. `ok` is true when the
// synthetic critical payload landed at the configured URL with a 2xx
// response; `status` echoes the upstream HTTP status (null on fetch throw);
// `latencyMs` always populated; `error` is a short message when fetch
// threw or returned a non-2xx.
export const NotificationTestResponse = z.object({
  ok: z.boolean(),
  status: z.number().int().nullable(),
  latencyMs: z.number().int(),
  error: z.string().nullable(),
});
export type NotificationTestResponse = z.infer<typeof NotificationTestResponse>;

// POST /api/alerts admin back-door body. `alertId` is optional — the
// handler generates one when the caller does not supply it (so a curl with
// `{"severity":"critical","title":"x"}` is enough to exercise the seam).
// `severity` is intentionally a free-form string at the contract layer so
// legacy callers can stamp their own labels; the createAlertForTeam helper
// does the case-insensitive `=== 'critical'` test it cares about.
export const AlertCreateBody = z.object({
  alertId: z.string().min(1).max(64).optional(),
  severity: z.string().min(1).max(64).optional(),
  title: z.string().min(1).max(280).optional(),
  findingId: z.string().min(1).max(64).optional(),
});
export type AlertCreateBody = z.infer<typeof AlertCreateBody>;
export type AlertCreateBodyInput = z.input<typeof AlertCreateBody>;

// Echoed back from POST /api/alerts so the caller can confirm the row and
// the delivery fan-out (or its absence).
export const AlertCreateResponse = z.object({
  id: z.string(),
  teamId: z.string(),
  severity: z.string().nullable(),
  title: z.string().nullable(),
  findingId: z.string().nullable(),
  createdAt: z.string(),
  delivered: z.boolean(),
  deliveryStatus: z.number().int().nullable(),
  deliveryError: z.string().nullable(),
});
export type AlertCreateResponse = z.infer<typeof AlertCreateResponse>;
