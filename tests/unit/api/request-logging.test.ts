// @vitest-environment node
// Additive: every in-scope v1 route header X-Request-ID and observes the
// structured log fields. Strict assertions on res.status/body shape stay
// in the other suite — this file checks observability only.

import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const scanFindMany = vi.fn();
const scanCount = vi.fn();
const apiKeyCreate = vi.fn();
const prismaScan = { findMany: scanFindMany, count: scanCount };
const prismaApiKey = { create: apiKeyCreate };

vi.mock('@/lib/db', () => ({
  prisma: {
    scan: prismaScan,
    apiKey: prismaApiKey,
  },
}));

const runScanMock = vi.fn();
vi.mock('@/lib/business/scanner/run-scan', () => ({
  runScan: (...args: unknown[]) => runScanMock(...args),
}));

const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  vi.resetModules();
  scanFindMany.mockReset();
  scanCount.mockReset();
  apiKeyCreate.mockReset();
  runScanMock.mockReset();
  consoleLog.mockClear();
  consoleError.mockClear();
});

// Mocks a permissive auth helper that resolves to a stable team context
// when X-API-Key is non-empty, and a 401 NextResponse otherwise.
function mockPermissiveApiKey(on: 'auth' | '503' | '401-when-present' = 'auth') {
  vi.doMock('@/lib/api-auth', () => ({
    verifyApiKey: async (req: Request) => {
      if (on === '503') {
        return NextResponse.json({ error: 'api_key_not_configured' }, { status: 503 });
      }
      const supplied = req.headers.get('x-api-key');
      if (!supplied) {
        return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
      }
      if (on === '401-when-present') {
        return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
      }
      return {
        ok: true as const,
        teamId: 'team-A',
        scopeKind: 'team' as const,
        scanId: null,
        keyId: 'key-test',
      };
    },
  }));
}

function findRouteLog(predicate: (line: Record<string, unknown>) => boolean) {
  const matches: Array<Record<string, unknown>> = [];
  for (const call of consoleLog.mock.calls) {
    const raw = call[0];
    if (typeof raw !== 'string') continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.msg === 'api.request' && predicate(parsed)) {
        matches.push(parsed);
      }
    } catch {
      /* not JSON */
    }
  }
  return matches;
}

describe('request logging: X-Request-ID on responses', () => {
  it('GET /api/v1/scans sets X-Request-ID on a 200', async () => {
    mockPermissiveApiKey();
    scanFindMany.mockResolvedValueOnce([]);
    scanCount.mockResolvedValueOnce(0);
    const { GET } = await import('@/app/api/v1/scans/route');
    const res = await GET(new Request('http://test/api/v1/scans', { method: 'GET' }));
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('GET /api/v1/scans sets X-Request-ID on a 401 when the key is missing', async () => {
    mockPermissiveApiKey();
    const { GET } = await import('@/app/api/v1/scans/route');
    const res = await GET(new Request('http://test/api/v1/scans', { method: 'GET' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('GET /api/v1/scans sets X-Request-ID on a 500 when prisma throws', async () => {
    mockPermissiveApiKey();
    scanFindMany.mockRejectedValueOnce(new Error('db down'));
    const { GET } = await import('@/app/api/v1/scans/route');
    const res = await GET(
      new Request('http://test/api/v1/scans', { method: 'GET', headers: { 'x-api-key': 'k' } }),
    );
    expect(res.status).toBe(500);
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes inbound X-Request-ID on /api/v1/scans', async () => {
    mockPermissiveApiKey();
    const { GET } = await import('@/app/api/v1/scans/route');
    const res = await GET(
      new Request('http://test/api/v1/scans', {
        method: 'GET',
        headers: { 'x-request-id': 'caller-supplied' },
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('x-request-id')).toBe('caller-supplied');
  });

  it('mints a new id when inbound X-Request-ID is malformed', async () => {
    mockPermissiveApiKey();
    const { GET } = await import('@/app/api/v1/scans/route');
    const res = await GET(
      new Request('http://test/api/v1/scans', {
        method: 'GET',
        headers: { 'x-request-id': 'has spaces inside' },
      }),
    );
    const id = res.headers.get('x-request-id');
    expect(id).not.toBe('has spaces inside');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('POST /api/v1/webhooks/trigger sets X-Request-ID on a 201', async () => {
    mockPermissiveApiKey();
    runScanMock.mockResolvedValueOnce({
      id: 'scan-new',
      target: 'a.example.org',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
    });
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(
      new Request('http://test/api/v1/webhooks/trigger', {
        method: 'POST',
        headers: { 'x-api-key': 'k', 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'a.example.org' }),
      }),
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('POST /api/v1/webhooks/trigger sets X-Request-ID on a 401', async () => {
    mockPermissiveApiKey();
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(new Request('http://test/api/v1/webhooks/trigger', { method: 'POST' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('request logging: structured route log fields', () => {
  it('POST /api/v1/webhooks/trigger emits a route log with teamId + keyId + scopeKind', async () => {
    mockPermissiveApiKey();
    runScanMock.mockResolvedValueOnce({
      id: 'scan-new',
      target: 'a.example.org',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
    });
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(
      new Request('http://test/api/v1/webhooks/trigger', {
        method: 'POST',
        headers: { 'x-api-key': 'k', 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'a.example.org' }),
      }),
    );
    expect(res.status).toBe(201);
    const matches = findRouteLog((l) => l.route === 'POST /api/v1/webhooks/trigger');
    expect(matches.length).toBeGreaterThan(0);
    const log = matches.at(-1);
    if (!log) throw new Error('expected a route log');
    expect(log.teamId).toBe('team-A');
    expect(log.keyId).toBe('key-test');
    expect(log.scopeKind).toBe('team');
    expect(log.statusCode).toBe(201);
    expect(typeof log.latencyMs).toBe('number');
  });

  it('GET /api/v1/scans 401 emits a route log with statusCode=401 and null auth', async () => {
    mockPermissiveApiKey();
    const { GET } = await import('@/app/api/v1/scans/route');
    const res = await GET(new Request('http://test/api/v1/scans', { method: 'GET' }));
    expect(res.status).toBe(401);
    const matches = findRouteLog((l) => l.route === 'GET /api/v1/scans');
    expect(matches.length).toBeGreaterThan(0);
    const log = matches.at(-1);
    if (!log) throw new Error('expected a route log');
    expect(log.statusCode).toBe(401);
    expect(log.teamId).toBeNull();
    expect(log.userId).toBeNull();
    expect(log.keyId).toBeNull();
    expect(log.scopeKind).toBeNull();
  });
});
