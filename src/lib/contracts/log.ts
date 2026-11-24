// @polsia:user-owned — zod schemas for the structured API request log + the
// captured error event emitted by src/lib/logging/*. Pure zod only — no
// server-only imports — so tests can import this file as a contract
// reference without mocking.

import { z } from 'zod';

export const ScopeKind = z.enum(['team', 'scan']);

export const ErrorPayload = z.object({
  name: z.string(),
  message: z.string(),
  stack: z.string().optional(),
});

export const RouteLogLevel = z.enum(['info', 'warn', 'error']);

export const RouteLog = z.object({
  ts: z.string(),
  level: RouteLogLevel,
  msg: z.literal('api.request'),
  requestId: z.string(),
  teamId: z.string().nullable(),
  userId: z.string().nullable(),
  keyId: z.string().nullable(),
  scopeKind: ScopeKind.nullable(),
  route: z.string(),
  method: z.string(),
  path: z.string(),
  statusCode: z.number().int(),
  latencyMs: z.number(),
  err: ErrorPayload.nullable(),
});

export const ErrorEvent = z.object({
  ts: z.string(),
  level: z.literal('error'),
  msg: z.literal('api.error'),
  requestId: z.string(),
  teamId: z.string().nullable(),
  userId: z.string().nullable(),
  keyId: z.string().nullable(),
  scopeKind: ScopeKind.nullable(),
  route: z.string(),
  method: z.string(),
  path: z.string(),
  request: z.object({
    url: z.string(),
    headers: z.record(z.string(), z.string()),
    body: z.unknown(),
  }),
  err: ErrorPayload,
});

export type RouteLogEntry = z.infer<typeof RouteLog>;
export type ErrorEventEntry = z.infer<typeof ErrorEvent>;
export type ErrorPayloadEntry = z.infer<typeof ErrorPayload>;
