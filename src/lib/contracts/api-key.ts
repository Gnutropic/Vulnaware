// @polsia:user-owned — zod contract for /api/v1/keys/**. Pure zod — no
// server-only imports so client islands can pull the same shape via
// apiFetch's schema option. Mirrors src/lib/contracts/example.ts style.

import { z } from 'zod';

// ===================== SCOPE PRIMITIVES =====================

// Allowed `scopeKind` values. Persisted as a String column in the prisma
// schema so this union is the single source of truth for the wire shape.
export const ApiKeyScopeKind = z.enum(['team', 'scan']);
export type ApiKeyScopeKind = z.infer<typeof ApiKeyScopeKind>;

// Path-parameter id validator — same shape as the v1 scan id regex so the
// create form, the route handler, and the URL all agree.
export const IdParam = z
  .string()
  .min(1, 'id required')
  .max(64, 'id too long')
  .regex(/^[A-Za-z0-9_-]+$/, 'invalid id format');

// ===================== WIRE SHAPES =====================

// Read shape — single row. `secret` is omitted here so /api/v1/keys GET
// cannot leak the plaintext; only the create response carries it.
export const ApiKeyTeamSummary = z.object({
  id: z.string(),
  name: z.string(),
});

export const ApiKeyItem = z.object({
  id: z.string(),
  name: z.string(),
  scopeKind: ApiKeyScopeKind,
  scanId: z.string().nullable(),
  team: ApiKeyTeamSummary,
  createdAt: z.string(), // ISO-8601 from prisma.toISOString()
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});

// GET /api/v1/keys response envelope.
export const ApiKeyList = z.object({
  items: z.array(ApiKeyItem),
});

// POST /api/v1/keys body — `name` (1..64), `scopeKind`, optional `scanId`
// when scopeKind = 'scan'. Reject `scanId` when scopeKind = 'team' via
// refine (server-side too).
export const ApiKeyCreateBody = z
  .object({
    name: z.string().min(1, 'Name is required').max(64, 'Name is too long'),
    scopeKind: ApiKeyScopeKind,
    scanId: IdParam.optional(),
  })
  .refine((value) => value.scopeKind !== 'scan' || value.scanId != null, {
    message: 'scanId is required for scan-scope keys',
    path: ['scanId'],
  })
  .refine((value) => value.scopeKind === 'scan' || value.scanId == null, {
    message: 'scanId may only be set for scan-scope keys',
    path: ['scanId'],
  });

// POST /api/v1/keys response — adds the ONE-TIME plaintext secret. The UI
// shows it inside a banner; subsequent renders must NOT include it (it's
// only present in the create response).
export const ApiKeyCreateResponse = ApiKeyItem.extend({
  secret: z.string().min(1),
});

export type ApiKeyTeamSummary = z.infer<typeof ApiKeyTeamSummary>;
export type ApiKeyItem = z.infer<typeof ApiKeyItem>;
export type ApiKeyList = z.infer<typeof ApiKeyList>;
export type ApiKeyCreateBody = z.infer<typeof ApiKeyCreateBody>;
export type ApiKeyCreateBodyInput = z.input<typeof ApiKeyCreateBody>;
export type ApiKeyCreateResponse = z.infer<typeof ApiKeyCreateResponse>;
