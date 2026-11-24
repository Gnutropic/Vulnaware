// @vitest-environment node
// Unit tests for the AsyncLocalStorage-backed logger + JSON emitter.

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

describe('logger module', () => {
  beforeEach(() => {
    consoleLog.mockClear();
    consoleError.mockClear();
  });

  it('mintRequestId returns a uuid-shaped string', () => {
    const id = randomUUID();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('normalizeInboundRequestId mints when missing/invalid', async () => {
    const { normalizeInboundRequestId } = await import('@/lib/logging/logger');
    expect(normalizeInboundRequestId(null)).toMatch(/^[0-9a-f-]{36}$/);
    expect(normalizeInboundRequestId('')).toMatch(/^[0-9a-f-]{36}$/);
    expect(normalizeInboundRequestId('   ')).toMatch(/^[0-9a-f-]{36}$/);
    // Too long / weird chars -> mint.
    expect(normalizeInboundRequestId('a'.repeat(500))).toMatch(/^[0-9a-f-]{36}$/);
    expect(normalizeInboundRequestId('bad value with spaces')).toMatch(/^[0-9a-f-]{36}$/);
    // Valid uuid-ish -> echoed.
    const echoed = 'req-12345';
    expect(normalizeInboundRequestId(echoed)).toBe(echoed);
  });

  it('logRequest emits a JSON line with stable shape', async () => {
    const { logRequest } = await import('@/lib/logging/logger');
    logRequest({
      requestId: 'req-1',
      method: 'GET',
      path: '/api/v1/scans',
      route: 'GET /api/v1/scans',
      statusCode: 200,
      latencyMs: 12,
      auth: { userId: null, teamId: 'team-A', keyId: null, scopeKind: 'team' },
      err: null,
    });
    expect(consoleLog).toHaveBeenCalledTimes(1);
    const line = consoleLog.mock.calls[0][0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.msg).toBe('api.request');
    expect(parsed.requestId).toBe('req-1');
    expect(parsed.teamId).toBe('team-A');
    expect(parsed.statusCode).toBe(200);
    expect(parsed.latencyMs).toBe(12);
    expect(parsed.err).toBeNull();
  });

  it('logRequest escalates level=error on 5xx', async () => {
    const { logRequest } = await import('@/lib/logging/logger');
    logRequest({
      requestId: 'req-2',
      method: 'POST',
      path: '/api/v1/keys',
      route: 'POST /api/v1/keys',
      statusCode: 500,
      latencyMs: 4,
      auth: { userId: null, teamId: null, keyId: null, scopeKind: null },
      err: { name: 'Error', message: 'db down' },
    });
    const line = JSON.parse(consoleLog.mock.calls.at(-1)?.[0] as string);
    expect(line.level).toBe('error');
    expect(line.err.message).toBe('db down');
  });

  it('runWithRequestContext propagates context across awaits', async () => {
    const { runWithRequestContext, getRequestId, setRequestAuth } = await import(
      '@/lib/logging/logger'
    );
    let innerId: string | undefined;
    let innerAuth: { userId: string | null } | null = null;
    await runWithRequestContext(
      {
        requestId: 'req-ctx',
        method: 'GET',
        path: '/x',
        route: 'GET /x',
        auth: { userId: null, teamId: null, keyId: null, scopeKind: null },
        startedAt: Date.now(),
      },
      async () => {
        await Promise.resolve();
        innerId = getRequestId();
        setRequestAuth({ userId: 'u1' });
        await new Promise((r) => setTimeout(r, 5));
        const ctx = (await import('@/lib/logging/logger')).getRequestLogger();
        innerAuth = ctx?.auth ?? null;
      },
    );
    expect(innerId).toBe('req-ctx');
    expect(innerAuth?.userId).toBe('u1');
  });
});
