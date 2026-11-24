// @vitest-environment node
// Neutralize server-only so the route handler can be unit-tested directly.
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const runScanMock = vi.fn(async () => ({
  id: 'scan-abc',
  target: 'scanme.example.org',
  mode: 'tcp-only',
  status: 'completed',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:05.000Z',
  assets: [],
  findings: [],
}));
vi.mock('@/lib/business/scanner/run-scan', () => ({
  runScan: runScanMock,
}));

// Stub the prisma client to avoid booting PrismaClient in tests.
const scanFindMany = vi.fn(async () => []);
const scanFindUnique = vi.fn();
vi.mock('@/lib/db', () => ({
  prisma: {
    scan: {
      findMany: scanFindMany,
      findUnique: scanFindUnique,
      create: vi.fn(),
      update: vi.fn(),
    },
    asset: { create: vi.fn(), findUnique: vi.fn() },
    vulnerabilityFinding: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    cveEntry: { findUnique: vi.fn(), create: vi.fn() },
  },
}));

const post = (body: unknown) => {
  const req = new Request('http://test/api/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return import('@/app/api/scan/route').then(({ POST }) => POST(req));
};

describe('/api/scan route', () => {
  it('GET returns 200 with an empty list envelope', async () => {
    const { GET } = await import('@/app/api/scan/route');
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ items: [] });
  });

  it('POST rejects a private target (127.0.0.1) with 400 + errors.target', async () => {
    const res = await post({ target: '127.0.0.1', ports: [22] });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body?.errors?.target).toBeTruthy();
  });

  it('POST rejects empty ports with 400 + errors.ports', async () => {
    const res = await post({ target: 'scanme.example.org', ports: [] });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body?.errors?.ports).toBeTruthy();
  });

  it('POST rejects an oversized port with 400', async () => {
    const res = await post({ target: 'scanme.example.org', ports: [22, 80, 443, 8080, 8443, 22] });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body?.errors?.ports).toBeTruthy();
  });

  it('POST with a valid public hostname returns 201 and calls runScan', async () => {
    runScanMock.mockClear();
    const res = await post({ target: 'scanme.example.org', ports: [22, 443] });
    expect(res.status).toBe(201);
    const item = await res.json();
    expect(item.id).toBe('scan-abc');
    expect(item.target).toBe('scanme.example.org');
    expect(runScanMock).toHaveBeenCalledOnce();
  });

  it('POST that throws in runScan surfaces a 502', async () => {
    runScanMock.mockRejectedValueOnce(new Error('dns down'));
    const res = await post({ target: 'scanme.example.org', ports: [443] });
    expect(res.status).toBe(502);
  });
});

describe('/api/scan/[id] route', () => {
  it('GET returns 404 when scan is not found', async () => {
    scanFindUnique.mockResolvedValueOnce(null);
    const { GET } = await import('@/app/api/scan/[id]/route');
    const res = await GET(new Request('http://test/api/scan/x'), {
      params: Promise.resolve({ id: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('GET returns the persisted ScanItem when present', async () => {
    scanFindUnique.mockResolvedValueOnce({
      id: 'scan-1',
      target: 'scanme.example.org',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      finishedAt: new Date('2026-01-01T00:00:05Z'),
      assets: [],
      findings: [],
    });
    const { GET } = await import('@/app/api/scan/[id]/route');
    const res = await GET(new Request('http://test/api/scan/scan-1'), {
      params: Promise.resolve({ id: 'scan-1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('scan-1');
  });
});
