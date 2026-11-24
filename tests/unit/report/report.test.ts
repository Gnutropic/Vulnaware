// @vitest-environment node
// Neutralize server-only so the route handler can be unit-tested directly.
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const scanFindUnique = vi.fn();
const cveEntryFindMany = vi.fn().mockResolvedValue([]);
vi.mock('@/lib/db', () => ({
  prisma: {
    scan: {
      findUnique: scanFindUnique,
    },
    cveEntry: {
      findMany: cveEntryFindMany,
    },
  },
}));

const get = async (id: string) => {
  const { GET } = await import('@/app/api/scan/[id]/report/route');
  return GET(new Request(`http://test/api/scan/${id}/report`), {
    params: Promise.resolve({ id }),
  });
};

describe('/api/scan/[id]/report route', () => {
  it('returns 404 when scan is not found', async () => {
    scanFindUnique.mockResolvedValueOnce(null);
    const res = await get('missing');
    expect(res.status).toBe(404);
  });

  it('returns an empty cveGroups envelope for a clean scan', async () => {
    scanFindUnique.mockResolvedValueOnce({
      id: 'scan-clean',
      target: 'clean.example.org',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      finishedAt: new Date('2026-01-01T00:00:05Z'),
      assets: [],
      findings: [],
    });
    const res = await get('scan-clean');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scan.id).toBe('scan-clean');
    expect(body.cveGroups).toEqual([]);
  });

  it('groups findings by cveId, attaches matched assets, and orders by priority', async () => {
    scanFindUnique.mockResolvedValueOnce({
      id: 'scan-2',
      target: 'scanme.example.org',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      finishedAt: new Date('2026-01-01T00:00:05Z'),
      assets: [
        {
          id: 'a-1',
          host: 'scanme.example.org',
          ip: '203.0.113.10',
          port: 443,
          protocol: 'tcp',
          state: 'up',
          latencyMs: 42,
          serviceHint: 'https',
          banner: 'OpenSSL/1.0.1e',
        },
        {
          id: 'a-2',
          host: 'scanme.example.org',
          ip: '203.0.113.10',
          port: 80,
          protocol: 'tcp',
          state: 'up',
          latencyMs: 38,
          serviceHint: 'http',
          banner: 'Apache/2.2.15',
        },
        {
          id: 'a-3',
          host: 'scanme.example.org',
          ip: '203.0.113.10',
          port: 22,
          protocol: 'tcp',
          state: 'up',
          latencyMs: 56,
          serviceHint: 'ssh',
          banner: 'SSH-2.0-OpenSSH_7.4',
        },
      ],
      findings: [
        // OPENSSL Heartbleed, High, on the 443 asset
        {
          id: 'f-1',
          assetId: 'a-1',
          scanId: 'scan-2',
          cveId: 'CVE-2014-0160',
          severity: 'High',
          matchReason: 'OpenSSL 1.0.1 banner',
          priorityScore: 5.9,
          epssScore: 0.05,
          epssPercentile: 0.6,
        },
        // Apache 2.2 newline, Medium, on the 80 asset
        {
          id: 'f-2',
          assetId: 'a-2',
          scanId: 'scan-2',
          cveId: 'CVE-2017-15715',
          severity: 'Medium',
          matchReason: 'Apache 2.2 banner',
          priorityScore: 3.0,
          epssScore: 0.04,
          epssPercentile: 0.5,
        },
        // The same Heartbleed finding again elsewhere — should collapse into the same group
        {
          id: 'f-3',
          assetId: 'a-3',
          scanId: 'scan-2',
          cveId: 'CVE-2014-0160',
          severity: 'High',
          matchReason: 'OpenSSL still vulnerable here',
          priorityScore: 5.9,
          epssScore: 0.05,
          epssPercentile: 0.6,
        },
      ],
    });
    // No matching CveEntry entries — handler still completes the shape.
    const res = await get('scan-2');
    expect(res.status).toBe(200);
    const body = await res.json();

    // Two distinct CVE groups (Heartbleed collapsed, Apache separate).
    expect(body.cveGroups.map((g: { cveId: string }) => g.cveId)).toEqual([
      'CVE-2014-0160',
      'CVE-2017-15715',
    ]);

    // Heartbleed group should reference both matched assets (a-1 and a-3).
    const heartbleed = body.cveGroups[0];
    expect(heartbleed.cveId).toBe('CVE-2014-0160');
    expect(heartbleed.matchedAssets.map((a: { id: string }) => a.id).sort()).toEqual([
      'a-1',
      'a-3',
    ]);

    // Heartbleed has a curated remediation entry.
    expect(heartbleed.recommendedFix).toMatch(/OpenSSL/);
    expect(heartbleed.fixVersionOrPatch).toBe('OpenSSL >= 1.0.1g');
    expect(heartbleed.verificationStep).toMatch(/openssl version/);
    expect(heartbleed.references[0]).toBe('https://nvd.nist.gov/vuln/detail/CVE-2014-0160');

    // Apache 2.2 group should reference the single asset a-2.
    const apache = body.cveGroups[1];
    expect(apache.cveId).toBe('CVE-2017-15715');
    expect(apache.matchedAssets).toHaveLength(1);
    expect(apache.matchedAssets[0].id).toBe('a-2');
  });

  it('falls back to the generic remediation entry for an unknown CVE', async () => {
    scanFindUnique.mockResolvedValueOnce({
      id: 'scan-3',
      target: 'unknown.example.org',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      finishedAt: new Date('2026-01-01T00:00:05Z'),
      assets: [
        {
          id: 'a-z',
          host: 'unknown.example.org',
          ip: '203.0.113.20',
          port: 443,
          protocol: 'tcp',
          state: 'up',
          latencyMs: 33,
          serviceHint: 'https',
          banner: 'Boring/1.0',
        },
      ],
      findings: [
        {
          id: 'f-z',
          assetId: 'a-z',
          scanId: 'scan-3',
          cveId: 'CVE-9999-99999',
          severity: 'Medium',
          matchReason: 'Generic match',
          priorityScore: 3.0,
          epssScore: 0.01,
          epssPercentile: 0.1,
        },
      ],
    });
    const res = await get('scan-3');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cveGroups).toHaveLength(1);
    const grp = body.cveGroups[0];
    expect(grp.cveId).toBe('CVE-9999-99999');
    expect(grp.recommendedFix).toMatch(/Upgrade the service/);
    expect(grp.fixVersionOrPatch).toBeNull();
    expect(grp.verificationStep).toMatch(/CVE-9999-99999/);
    expect(grp.references).toEqual(['https://nvd.nist.gov/vuln/detail/CVE-9999-99999']);
  });

  it('returns 500 on unexpected DB failures (swallowed)', async () => {
    scanFindUnique.mockRejectedValueOnce(new Error('db down'));
    const res = await get('scan-err');
    expect(res.status).toBe(500);
  });
});
