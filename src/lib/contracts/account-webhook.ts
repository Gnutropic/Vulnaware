// @polsia:user-owned — Wire contracts for /api/account/webhook/**. Pure zod,
// no server-only/db imports so both the route handler and the client island
// can share the single source of truth (a contract drift surfaces as a `tsc`
// error / runtime ZodError rather than a silent shape mismatch).
//
// The saved URL is mirrored over the GET/PUT boundary as `url` (not
// `webhookUrl`); the on-the-wire alert payload stays snake_case per the
// brief so downstream consumers can grep `alert_id`/`cve_id` directly.

import { z } from 'zod';

// GET /api/account/webhook response. `url` is null when the user has no
// saved endpoint yet; `updatedAt` is the DB row's last-write stamp
// (ISO-8601, UTC ms serialised from Date.toISOString()) so the UI can
// render a "Last updated 3 minutes ago" hint.
export const UserWebhookConfigItem = z.object({
  url: z.string().nullable(),
  updatedAt: z.string(),
});
export type UserWebhookConfigItem = z.infer<typeof UserWebhookConfigItem>;

// PUT /api/account/webhook body — upsert the user's webhook URL. `url` is
// `string().url().max(2048)` to fit the standard Slack-share-style URL;
// `nullable()` so a PUT of `{ url: null }` wipes a saved endpoint by
// overwriting the column with NULL. The route handler additionally rejects
// `http://` (must be https) — see the contract-less field-level check
// inside the handler.
export const UserWebhookSetBody = z.object({
  url: z.string().url().max(2048).nullable(),
});
export type UserWebhookSetBody = z.infer<typeof UserWebhookSetBody>;
export type UserWebhookSetBodyInput = z.input<typeof UserWebhookSetBody>;

// PUT /api/account/webhook response — echoes the saved value the way the
// team path does, so the UI can render the same string the operator typed
// after Save. Same shape as the GET response (the route handler returns
// { url, updatedAt } on both verbs so the client reuses one zod node).
export const UserWebhookSetResponse = UserWebhookConfigItem;
export type UserWebhookSetResponse = z.infer<typeof UserWebhookSetResponse>;

// One row of the per-user delivery ring buffer. `payloadKind` is 'alert'
// for a live alert POSTed by `deliverNewAlertUserWebhooks` and 'test' for
// the empty-config branch plus the manual `Send test` send. `responseCode`
// is null when the request threw (DNS / TCP / TLS / fetch escaped);
// `snippet` is `res.text().slice(0, 256)` on a response body, `err.message`
// on fetch-throw / timeout, null on empty body. `latencyMs` is always set
// so the UI can render a row even when the call failed mid-flight.
export const UserWebhookDeliveryItem = z.object({
  id: z.string(),
  attemptedAt: z.string(),
  targetUrl: z.string(),
  payloadKind: z.enum(['alert', 'test']),
  alertId: z.string().nullable(),
  responseCode: z.number().int().nullable(),
  latencyMs: z.number().int(),
  snippet: z.string().nullable(),
});
export type UserWebhookDeliveryItem = z.infer<typeof UserWebhookDeliveryItem>;

// GET response — the saved config + last 20 delivery attempts in
// attemptedAt-desc order. Single round-trip so the page can mount without
// thrashing the data plane.
export const UserWebhookGetResponse = z.object({
  url: z.string().nullable(),
  updatedAt: z.string(),
  deliveries: z.array(UserWebhookDeliveryItem),
});
export type UserWebhookGetResponse = z.infer<typeof UserWebhookGetResponse>;

// POST /api/account/webhook/test response. Always 200 OK regardless of
// upstream outcome; `ok` distinguishes success (2xx and reachable) from
// failure. `status` echoes the upstream HTTP status (null on fetch-throw);
// `latencyMs` always populated via `performance.now()` so the UI can render
// a row even when the call failed mid-flight; `error` is null on a 2xx
// response and a short message otherwise.
export const UserWebhookTestResponse = z.object({
  ok: z.boolean(),
  status: z.number().int().nullable(),
  latencyMs: z.number().int(),
  error: z.string().nullable(),
});
export type UserWebhookTestResponse = z.infer<typeof UserWebhookTestResponse>;
