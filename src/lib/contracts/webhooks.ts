// @polsia:user-owned — zod contract for /api/v1/webhooks/**. Pure zod — no
// server-only imports so client islands can pull the same shape via
// apiFetch's schema option. Mirrors src/lib/contracts/api-key.ts style.

import { z } from 'zod';
import { ApiKeyTeamSummary } from '@/lib/contracts/api-key';

// ===================== SCOPE PRIMITIVES =====================

// Allowed `signingAlgorithm` values. Persisted as a String column in the
// prisma schema so this union is the single source of truth for the wire
// shape; future algorithms can be added without a migration.
export const WebhookSigningAlgorithm = z.enum(['hmac-sha256']);
export type WebhookSigningAlgorithm = z.infer<typeof WebhookSigningAlgorithm>;

// Path-parameter id validator — same shape as the api-key id validator so the
// create form, the route handler, and the URL all agree.
export const IdParam = z
  .string()
  .min(1, 'id required')
  .max(64, 'id too long')
  .regex(/^[A-Za-z0-9_-]+$/, 'invalid id format');

// ===================== WIRE SHAPES =====================

// Read shape — single row. `secret` is omitted here so /api/v1/webhooks GET
// cannot leak the plaintext; only the create response carries it.
export const WebhookItem = z.object({
  id: z.string(),
  url: z.string(),
  signingAlgorithm: WebhookSigningAlgorithm,
  lastSignedAt: z.string().nullable(), // ISO-8601
  createdAt: z.string(), // ISO-8601
  revokedAt: z.string().nullable(),
  team: ApiKeyTeamSummary,
});

// GET /api/v1/webhooks response envelope.
export const WebhookList = z.object({
  items: z.array(WebhookItem),
});

// POST /api/v1/webhooks body — `url` only (HTTPS is recommended but not
// enforced at the contract layer so customers can wire internal URLs).
export const WebhookCreateBody = z.object({
  url: z.string().url().max(2048),
});

// POST /api/v1/webhooks response — adds the ONE-TIME plaintext secret. The
// UI shows it inside a banner; subsequent renders must NOT include it.
export const WebhookCreateResponse = WebhookItem.extend({
  secret: z.string().min(1),
});

export type WebhookItem = z.infer<typeof WebhookItem>;
export type WebhookList = z.infer<typeof WebhookList>;
export type WebhookCreateBody = z.infer<typeof WebhookCreateBody>;
export type WebhookCreateBodyInput = z.input<typeof WebhookCreateBody>;
export type WebhookCreateResponse = z.infer<typeof WebhookCreateResponse>;
