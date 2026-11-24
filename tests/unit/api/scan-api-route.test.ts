// @vitest-environment node
// Unit tests for the v1 enterprise REST endpoints.
// After the auth helper `verifyApiKey` was rewritten to look up
// db-backed scoped keys (src/lib/api-auth.ts), this file mocks that
// module with a faithful env-string replacement so the existing
// 401/503/200-success cases stay stable. The DB-backed auth path is
// covered in tests/unit/api/api-key-route.test.ts.
// Scoping tests (per-team / per-scan filter rules) use `mockApiKeyResolve`
// below to bypass auth and inject an explicit ApiKeyContext.

import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

// Mutable env key — keeps the 401/503/200-success path symmetric with
// the original test surface.
const TEST_KEY = 'apiKey12345678901234567890123456';
const SAME_LEN_WRONG = 'apiKey12345678901234567890123457';
let ENV_VULN_KEY: string | undefined = TEST_KEY;

// Mock @/lib/api-auth entirely. The factory closes over `TEST_KEY` and
// `NextResponse`; both are top-level and are reachable from the hoisted
// vi.mock factory.
vi.mock('@/lib/api-auth', () => ({
  verifyApiKey: async (req: Request) => {
    const configured = ENV_VULN_KEY;
    if (!configured) {
      return NextResponse.json({ error: 'api_key_not_configured' }, { status: 503 });
    }
    const supplied = req.headers.get('x-api-key');
    if (!supplied || supplied.length === 0) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    if (supplied !== configured) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    return {
      ok: true as const,
      teamId: 'team-test',
      scopeKind: 'team' as const,
      scanId: null,
      keyId: 'key-test',
    };
  },
}));

// Stub prisma — env-stub style. Avoids booting PrismaClient.
const scanFindMany = vi.fn();
const scanFindUnique = vi.fn();
const scanCount = vi.fn();
const cveEntryFindMany = vi.fn();
vi.mock('@/lib/db', () => ({
  prisma: {
    scan: {
      findMany: scanFindMany,
      findUnique: scanFindUnique,
      count: scanCount,
    },
    cveEntry: {
      findMany: cveEntryFindMany,
    },
  },
}));

const auth = (key: string | null) => {
  const headers: Record<string, string> = {};
  if (key !== null) headers['x-api-key'] = key;
  return new Request('http://test/api/v1/scans', { method: 'GET', headers });
};

const authFindings = (key: string | null, id: string, query = '') => {
  const headers: Record<string, string> = {};
  if (key !== null) headers['x-api-key'] = key;
  return new Request(`http://test/api/v1/scans/${id}/findings${query}`, {
    method: 'GET',
    headers,
  });
};

beforeEach(() => {
  vi.resetModules();
  ENV_VULN_KEY = TEST_KEY;
  scanFindMany.mockReset();
  scanFindUnique.mockReset();
  scanCount.mockReset();
  cveEntryFindMany.mockReset();
});

// ===================== AUTH ENVELOPES =====================

describe('GET /api/v1/scans auth', () => {
  it('returns 401 when X-API-Key header is missing', async () => {
    const { GET } = await import('@/app/api/v1/scans/route');
    const res = await GET(auth(null));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
  });

  it('returns 401 when X-API-Key is empty', async () => {
    const { GET } = await import('@/app/api/v1/scans/route');
    const res = await GET(auth(''));
    expect(res.status).toBe(401);
  });

  it('returns 401 when X-API-Key has wrong length', async () => {
    const { GET } = await import('@/app/api/v1/scans/route');
    const res = await GET(auth('short'));
    expect(res.status).toBe(401);
  });

  it('returns 401 when X-API-Key has correct length but wrong value', async () => {
    const { GET } = await import('@/app/api/v1/scans/route');
    expect(SAME_LEN_WRONG.length).toBe(TEST_KEY.length);
    const res = await GET(auth(SAME_LEN_WRONG));
    expect(res.status).toBe(401);
  });

  it('returns 200 when X-API-Key matches', async () => {
    scanFindMany.mockResolvedValueOnce([]);
    scanCount.mockResolvedValueOnce(0);
    const { GET } = await import('@/app/api/v1/scans/route');
    const res = await GET(auth(TEST_KEY));
    expect(res.status).toBe(200);
  });
});

describe('GET /api/v1/scans auth when env key is unset', () => {
  it('returns 503 api_key_not_configured', async () => {
    ENV_VULN_KEY = undefined;
    const { GET } = await import('@/app/api/v1/scans/route');
    const res = await GET(auth(TEST_KEY));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('api_key_not_configured');
  });
});

describe('GET /api/v1/scans response shape', () => {
  it('returns the EnterpriseScanListResponse envelope with empty items', async () => {
    scanFindMany.mockResolvedValueOnce([]);
    scanCount.mockResolvedValueOnce(0);
    const { GET } = await import('@/app/api/v1/scans/route');
    const res = await GET(auth(TEST_KEY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ items: [], limit: 50, offset: 0, total: 0 });
  });

  it('returns scan headers sorted by startedAt desc with correct shape', async () => {
    scanFindMany.mockResolvedValueOnce([
      {
        id: 'c1',
        target: 'a.example.org',
        mode: 'tcp-only',
        status: 'completed',
        startedAt: new Date('2026-01-02T00:00:00Z'),
        finishedAt: new Date('2026-01-02T00:00:05Z'),
      },
      {
        id: 'c2',
        target: 'b.example.org',
        mode: 'tcp-only',
        status: 'failed',
        startedAt: new Date('2026-01-01T00:00:00Z'),
        finishedAt: null,
      },
    ]);
    scanCount.mockResolvedValueOnce(2);
    const { GET } = await import('@/app/api/v1/scans/route');
    const res = await GET(auth(TEST_KEY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.items[0].id).toBe('c1');
    expect(body.items[0].startedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(body.items[0].finishedAt).toBe('2026-01-02T00:00:05.000Z');
    expect(body.items[1].finishedAt).toBeNull();
  });

  it('respects ?limit and ?offset and forwards them to prisma', async () => {
    scanFindMany.mockResolvedValueOnce([]);
    scanCount.mockResolvedValueOnce(7);
    const { GET } = await import('@/app/api/v1/scans/route');
    const res = await GET(
      new Request('http://test/api/v1/scans?limit=2&offset=3', {
        headers: { 'x-api-key': TEST_KEY },
      }),
    );
    expect(res.status).toBe(200);
    expect(scanFindMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 3, take: 2 }));
    const body = await res.json();
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(3);
    expect(body.total).toBe(7);
  });

  it('returns 400 on invalid query (negative offset)', async () => {
    const { GET } = await import('@/app/api/v1/scans/route');
    const res = await GET(
      new Request('http://test/api/v1/scans?offset=-1', {
        headers: { 'x-api-key': TEST_KEY },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 500 when prisma throws', async () => {
    scanFindMany.mockRejectedValueOnce(new Error('db down'));
    const { GET } = await import('@/app/api/v1/scans/route');
    const res = await GET(auth(TEST_KEY));
    expect(res.status).toBe(500);
  });
});

describe('GET /api/v1/scans/[id]/findings', () => {
  it('returns 404 when scan is not found', async () => {
    scanFindUnique.mockResolvedValueOnce(null);
    const { GET } = await import('@/app/api/v1/scans/[id]/findings/route');
    const res = await GET(authFindings(TEST_KEY, 'not-a-cuid'), {
      params: Promise.resolve({ id: 'not-a-cuid' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 when id format is invalid', async () => {
    const { GET } = await import('@/app/api/v1/scans/[id]/findings/route');
    const res = await GET(authFindings(TEST_KEY, 'id with spaces'), {
      params: Promise.resolve({ id: 'id with spaces' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 before touching prisma', async () => {
    const { GET } = await import('@/app/api/v1/scans/[id]/findings/route');
    const res = await GET(authFindings(null, 'ok-id'), {
      params: Promise.resolve({ id: 'ok-id' }),
    });
    expect(res.status).toBe(401);
    expect(scanFindUnique).not.toHaveBeenCalled();
  });

  it('returns the EnterpriseScanFindingsResponse envelope with sorted findings', async () => {
    scanFindUnique.mockResolvedValueOnce({
      id: 'scan-1',
      target: 'scanme.example.org',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      finishedAt: new Date('2026-01-01T00:00:05Z'),
      teamId: 'team-test',
      assets: [
        {
          id: 'asset-1',
          host: 'scanme.example.org',
          ip: '203.0.113.10',
          port: 443,
          serviceHint: 'https',
          banner: 'Apache/2.2.15',
        },
      ],
      findings: [
        {
          id: 'f-low',
          scanId: 'scan-1',
          assetId: 'asset-1',
          cveId: 'CVE-2014-0160',
          severity: 'high',
          matchReason: 'OpenSSL 1.0.1f banner matched Heartbleed rule.',
          priorityScore: 8.5,
          epssScore: 0.94,
          epssPercentile: 0.99,
          kevListed: false,
          kevListedAt: null,
        },
        {
          id: 'f-other',
          scanId: 'scan-1',
          assetId: 'asset-1',
          cveId: 'CVE-2017-15715',
          severity: 'medium',
          matchReason: 'Apache newline-in-Filename.',
          priorityScore: 5.0,
          epssScore: 0.1,
          epssPercentile: 0.5,
          kevListed: false,
          kevListedAt: null,
        },
      ],
    });
    cveEntryFindMany.mockResolvedValueOnce([
      { cveId: 'CVE-2014-0160', cvssScore: 7.5 },
      { cveId: 'CVE-2017-15715', cvssScore: 6.5 },
    ]);
    const { GET } = await import('@/app/api/v1/scans/[id]/findings/route');
    const res = await GET(authFindings(TEST_KEY, 'scan-1'), {
      params: Promise.resolve({ id: 'scan-1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scan.id).toBe('scan-1');
    expect(body.total).toBe(2);
    expect(body.findings).toHaveLength(2);
    expect(body.findings[0].cveId).toBe('CVE-2014-0160');
    expect(body.findings[0].priorityScore).toBe(8.5);
    expect(body.findings[0].asset.host).toBe('scanme.example.org');
    expect(body.findings[0].asset.port).toBe(443);
    expect(body.findings[0].cvssScore).toBe(7.5);
    expect(body.findings[0].remediation.recommendedFix).toMatch(/OpenSSL/);
    expect(body.findings[0].remediation.fixVersionOrPatch).toBe('OpenSSL >= 1.0.1g');
    expect(body.findings[0].remediation.references.length).toBeGreaterThan(0);
    expect(body.findings[1].cveId).toBe('CVE-2017-15715');
  });

  it('returns paginated findings (slice after sort)', async () => {
    scanFindUnique.mockResolvedValueOnce({
      id: 'scan-1',
      target: 'scanme.example.org',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      finishedAt: new Date('2026-01-01T00:00:05Z'),
      teamId: 'team-test',
      assets: [
        {
          id: 'asset-1',
          host: 'scanme.example.org',
          ip: '203.0.113.10',
          port: 443,
          serviceHint: 'https',
          banner: 'banner',
        },
      ],
      findings: Array.from({ length: 5 }, (_, i) => ({
        id: `f-${i}`,
        scanId: 'scan-1',
        assetId: 'asset-1',
        cveId: `CVE-2020-${String(1000 + i).padStart(4, '0')}`,
        severity: 'medium',
        matchReason: 'reason',
        priorityScore: 5 - i,
        epssScore: 0.1,
        epssPercentile: 0.5,
        kevListed: false,
        kevListedAt: null,
      })),
    });
    cveEntryFindMany.mockResolvedValueOnce([]);
    const { GET } = await import('@/app/api/v1/scans/[id]/findings/route');
    const res = await GET(authFindings(TEST_KEY, 'scan-1', '?limit=2&offset=1'), {
      params: Promise.resolve({ id: 'scan-1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(5);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(1);
    expect(body.findings).toHaveLength(2);
    expect(body.findings[0].priorityScore).toBe(4);
    expect(body.findings[1].priorityScore).toBe(3);
  });

  it('returns 500 when prisma throws', async () => {
    scanFindUnique.mockRejectedValueOnce(new Error('db down'));
    const { GET } = await import('@/app/api/v1/scans/[id]/findings/route');
    const res = await GET(authFindings(TEST_KEY, 'scan-1'), {
      params: Promise.resolve({ id: 'scan-1' }),
    });
    expect(res.status).toBe(500);
  });
});

// ===================== SCOPING (new) =====================

function mockApiKeyResolve(
  context:
    | {
        teamId: string;
        scopeKind: 'team' | 'scan';
        scanId?: string | null;
        keyId?: string;
      }
    | NextResponse,
) {
  if (context instanceof NextResponse) {
    vi.doMock('@/lib/api-auth', () => ({
      verifyApiKey: async () => context,
    }));
    return;
  }
  const ctx = {
    ok: true as const,
    teamId: context.teamId,
    scopeKind: context.scopeKind,
    scanId: context.scanId ?? null,
    keyId: context.keyId ?? 'key-test',
  };
  vi.doMock('@/lib/api-auth', () => ({
    verifyApiKey: async () => ctx,
  }));
}

describe('GET /api/v1/scans scoping', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('passes where: { teamId: ctx.teamId } to prisma.scan.findMany + count', async () => {
    mockApiKeyResolve({ teamId: 'team-A', scopeKind: 'team' });
    scanFindMany.mockResolvedValueOnce([]);
    scanCount.mockResolvedValueOnce(0);
    const { GET } = await import('@/app/api/v1/scans/route');
    const res = await GET(auth(TEST_KEY));
    expect(res.status).toBe(200);
    expect(scanFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teamId: 'team-A' } }),
    );
    expect(scanCount).toHaveBeenCalledWith({ where: { teamId: 'team-A' } });
  });

  it('returns 403 forbidden_scope when the key is scan-scope', async () => {
    mockApiKeyResolve({ teamId: 'team-A', scopeKind: 'scan', scanId: 'scan-1' });
    const { GET } = await import('@/app/api/v1/scans/route');
    const res = await GET(auth(TEST_KEY));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden_scope');
    expect(scanFindMany).not.toHaveBeenCalled();
    expect(scanCount).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/scans/[id]/findings scoping', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns 403 forbidden_other_team when scan.teamId !== ctx.teamId', async () => {
    mockApiKeyResolve({ teamId: 'team-A', scopeKind: 'team' });
    scanFindUnique.mockResolvedValueOnce({
      id: 'scan-1',
      target: 'scanme.example.org',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      finishedAt: new Date('2026-01-01T00:00:05Z'),
      teamId: 'team-B',
      assets: [],
      findings: [],
    });
    const { GET } = await import('@/app/api/v1/scans/[id]/findings/route');
    const res = await GET(authFindings(TEST_KEY, 'scan-1'), {
      params: Promise.resolve({ id: 'scan-1' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden_other_team');
    expect(cveEntryFindMany).not.toHaveBeenCalled();
  });

  it('returns 403 forbidden_other_scan when scopeKind=scan and scanId mismatches', async () => {
    mockApiKeyResolve({ teamId: 'team-A', scopeKind: 'scan', scanId: 'scan-1' });
    scanFindUnique.mockResolvedValueOnce({
      id: 'scan-2',
      target: 'scanme.example.org',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      finishedAt: new Date('2026-01-01T00:00:05Z'),
      teamId: 'team-A',
      assets: [],
      findings: [],
    });
    const { GET } = await import('@/app/api/v1/scans/[id]/findings/route');
    const res = await GET(authFindings(TEST_KEY, 'scan-2'), {
      params: Promise.resolve({ id: 'scan-2' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden_other_scan');
  });

  it('returns 200 when scan-scope key is bound to the requested scan and team matches', async () => {
    mockApiKeyResolve({ teamId: 'team-A', scopeKind: 'scan', scanId: 'scan-1' });
    scanFindUnique.mockResolvedValueOnce({
      id: 'scan-1',
      target: 'scanme.example.org',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      finishedAt: new Date('2026-01-01T00:00:05Z'),
      teamId: 'team-A',
      assets: [],
      findings: [],
    });
    cveEntryFindMany.mockResolvedValueOnce([]);
    const { GET } = await import('@/app/api/v1/scans/[id]/findings/route');
    const res = await GET(authFindings(TEST_KEY, 'scan-1'), {
      params: Promise.resolve({ id: 'scan-1' }),
    });
    expect(res.status).toBe(200);
  });
});
