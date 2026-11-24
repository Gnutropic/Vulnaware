// @polsia:user-owned — zod contract for /api/v1/webhooks/triggers. Pure zod —
// no server-only imports so client islands can pull the same shape via
// apiFetch's schema option. The list endpoint deliberately omits every
// signing-secret column (secret, header name, signingSecretCipher, etc.) and
// flips `.strict()` on so any unknown field rejected at the parse layer
// doubles as a redaction gate — a future handler that accidentally leaks a
// secret will fail fast.

import { z } from 'zod';
import { WebhookSigningAlgorithm } from '@/lib/contracts/webhooks';

// ===================== STATUS PRIMITIVE =====================

// Allowed `status` values. Mirrors Scan.status + the WebhookTrigger row's
// referenced scan: the route projects Scan.status through a join so this
// enum governs the surface rather than the WebhookTrigger table itself.
export const WebhookTriggerStatus = z.enum(['queued', 'running', 'completed', 'failed']);
export type WebhookTriggerStatus = z.infer<typeof WebhookTriggerStatus>;

// ===================== WIRE SHAPES =====================

// Single row shape. .strict() so any future leaked column (e.g. signingSecretCipher
// if a handler accidentally `include`s the Webhook relation) fails parse
// before reaching the client.
export const WebhookTriggerItem = z
  .object({
    id: z.string(),
    scanId: z.string(),
    receivedAt: z.string(), // ISO-8601
    repositoryUrl: z.string(),
    repositoryRef: z.string().nullable(),
    repositoryCommit: z.string().nullable(),
    buildId: z.string().nullable(),
    buildStatus: z.string().nullable(),
    buildBranch: z.string().nullable(),
    signatureAlgorithm: WebhookSigningAlgorithm,
    status: WebhookTriggerStatus,
  })
  .strict();

// GET /api/v1/webhooks/triggers response envelope.
export const WebhookTriggerList = z.object({
  items: z.array(WebhookTriggerItem),
});

export type WebhookTriggerItem = z.infer<typeof WebhookTriggerItem>;
export type WebhookTriggerList = z.infer<typeof WebhookTriggerList>;
