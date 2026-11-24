// @polsia:user-owned — AsyncLocalStorage-backed request context + JSON-line
// emitter. Single source of truth for `console.*` writes inside the logging
// stack. The wrapper (`with-request.ts`) calls `runWithRequestContext` to
// scope the context, and `getRequestLogger()` lets handler-level code
// reach the same context from any awaited continuation.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import 'server-only';
import type { z } from 'zod';
import type { ErrorPayloadEntry, ScopeKind } from '@/lib/contracts/log';

type ScopeKindValue = z.infer<typeof ScopeKind>;

export interface RequestAuthContext {
  userId: string | null;
  teamId: string | null;
  keyId: string | null;
  scopeKind: ScopeKindValue | null;
}

export interface RequestContext {
  requestId: string;
  method: string;
  path: string;
  route: string;
  auth: RequestAuthContext;
  startedAt: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function getRequestLogger(): RequestContext | undefined {
  return storage.getStore();
}

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

export function setRequestAuth(auth: Partial<RequestAuthContext>): void {
  const current = storage.getStore();
  if (!current) return;
  current.auth = { ...current.auth, ...auth };
}

export function mintRequestId(): string {
  return randomUUID();
}

const UUIDISH = /^[A-Za-z0-9._:-]{1,128}$/;

export function normalizeInboundRequestId(raw: string | null | undefined): string {
  if (!raw) return mintRequestId();
  const trimmed = raw.trim();
  if (!trimmed) return mintRequestId();
  if (!UUIDISH.test(trimmed)) return mintRequestId();
  return trimmed;
}

function emitRouteLog(record: Record<string, unknown>): void {
  const line = JSON.stringify(record);
  // biome-ignore lint/suspicious/noConsole: structured logger sink
  console.log(line);
}

function emitErrorEvent(record: Record<string, unknown>): void {
  const line = JSON.stringify(record);
  // biome-ignore lint/suspicious/noConsole: structured logger sink
  console.error(line);
}

export interface EmitRouteLogInput {
  requestId: string;
  method: string;
  path: string;
  route: string;
  statusCode: number;
  latencyMs: number;
  auth: RequestAuthContext;
  err: ErrorPayloadEntry | null;
}

export function logRequest(input: EmitRouteLogInput): void {
  emitRouteLog({
    ts: new Date().toISOString(),
    level: input.statusCode >= 500 || input.err ? 'error' : 'info',
    msg: 'api.request',
    requestId: input.requestId,
    teamId: input.auth.teamId,
    userId: input.auth.userId,
    keyId: input.auth.keyId,
    scopeKind: input.auth.scopeKind,
    route: input.route,
    method: input.method,
    path: input.path,
    statusCode: input.statusCode,
    latencyMs: input.latencyMs,
    err: input.err,
  });
}

export function emitErrorLogEvent(record: Record<string, unknown>): void {
  emitErrorEvent(record);
}
