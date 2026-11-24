// @polsia:user-owned — zod contract for the public bearer-token CI ingest
// endpoint, POST /api/ci/webhook. Re-exports the request/response shapes from
// the v1 trigger contract so this route agrees with the rest of the /api
// surface, and ships a small `CiWebhookTokenInfo` schema the Wire it up UI
// uses to render "where to set the token" hints without ever displaying the
// plaintext value.
//
// zod-only — no server-only imports here. The route handler is the single
// consumer at runtime, but matching the same-file pattern as example.ts so a
// client island could import the response type if a future "show me the last
// scan id" UI ever needs it.

import type { z } from 'zod';
import {
  WebhookTriggerBody,
  type WebhookTriggerBodyInput,
  WebhookTriggerResponse,
} from '@/lib/contracts/scan-api';

// Request body — identical shape to the v1 trigger contract. The route
// validates input against this; clients can import the inferred type for
// typed POST helpers without crossing into scan-api.ts.
export const CiWebhookTriggerBody = WebhookTriggerBody;

// Response envelope — same shape POST /api/v1/webhooks/trigger returns.
// Status code is 202 (vs the v1 201) to reflect the single-factor auth
// posture (bearer token only — no HMAC) and the fire-and-forget scan write
// downstream.
export const CiWebhookTriggerResponse = WebhookTriggerResponse;

export type CiWebhookTriggerBody = z.infer<typeof CiWebhookTriggerBody>;
export type CiWebhookTriggerBodyInput = WebhookTriggerBodyInput;
export type CiWebhookTriggerResponse = z.infer<typeof CiWebhookTriggerResponse>;
