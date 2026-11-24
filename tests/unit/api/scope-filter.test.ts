// @vitest-environment node
// Scope-filter smoke tests for the existing v1 handlers (list, findings,
// trigger). Spins assertions around the per-team / per-scan rules without
// booting prisma — mocks @/lib/api-auth and the parts of prisma the
// handler actually touches.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const scanFindMany = vi.fn();
const scanCount = vi.fn();
const scanFindUnique = vi.fn();
const cveEntryFindMany = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    scan: {
      findMany: scanFindMany,
      count: scanCount,
      findUnique: scanFindUnique,
    },
    cveEntry: {
      findMany: cveEntryFindMany,
    },
  },
}));

// runScan is consumed by /api/v1/webhooks/trigger — replace it with a
// stub that captures the teamId option for assertion.
const runScanMock = vi.fn();
vi.mock('@/lib/business/scanner/run-scan', () => ({
  runScan: (...args: unknown[]) => runScanMock(...args),
}));

beforeEach(() => {
  vi.resetModules();
  scanFindMany.mockReset();
  scanCount.mockReset();
  scanFindUnique.mockReset();
  cveEntryFindMany.mockReset();
  runScanMock.mockReset();
});

const TEST_KEY = 'apiKey12345678901234567890123456';

function auth(key: string | null) {
  const headers: Record<string, string> = {};
  if (key !== null) headers['x-api-key'] = key;
  return new Request('http://test/api/v1/webhooks/trigger', {
    method: 'POST',
    headers,
    body: JSON.stringify({ target: 'a.example.org' }),
  });
}

function mockApiKey(context: {
  teamId: string;
  scopeKind: 'team' | 'scan';
  scanId?: string | null;
  keyId?: string;
}) {
  vi.doMock('@/lib/api-auth', () => ({
    verifyApiKey: async () => ({
      ok: true as const,
      teamId: context.teamId,
      scopeKind: context.scopeKind,
      scanId: context.scanId ?? null,
      keyId: context.keyId ?? 'key-test',
    }),
  }));
}

// ===================== TRIGGER (POST /api/v1/webhooks/trigger) =====================

describe('POST /api/v1/webhooks/trigger scoping', () => {
  it('passes teamId into runScan for a team-scope key', async () => {
    mockApiKey({ teamId: 'team-A', scopeKind: 'team' });
    runScanMock.mockResolvedValueOnce({
      id: 'scan-new',
      target: 'a.example.org',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
    });
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(auth(TEST_KEY));
    expect(res.status).toBe(201);
    expect(runScanMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ teamId: 'team-A' }),
    );
  });

  it('returns 405 scope_not_supported for scan-scope keys', async () => {
    mockApiKey({ teamId: 'team-A', scopeKind: 'scan', scanId: 'scan-1' });
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(auth(TEST_KEY));
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.code).toBe('scope_not_supported');
    expect(runScanMock).not.toHaveBeenCalled();
  });

  it('returns 503 when no keys are configured', async () => {
    vi.doMock('@/lib/api-auth', () => ({
      verifyApiKey: async () => {
        // Mimic 503 from the real verifyApiKey when table is empty.
        const { NextResponse } = await import('next/server');
        return NextResponse.json({ error: 'api_key_not_configured' }, { status: 503 });
      },
    }));
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(auth(TEST_KEY));
    expect(res.status).toBe(503);
  });
});
