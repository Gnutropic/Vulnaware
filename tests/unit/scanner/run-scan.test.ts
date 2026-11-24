// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const scannerMocks = vi.hoisted(() => {
  type MatcherHit = { cveId: string; severity: string; matchReason: string };
  type CveMetadata = {
    cveId: string;
    cvssScore: number | null;
    severity: string | null;
    description: string;
    vector: string | null;
    publishedAt: Date | null;
  };
  type EpssEntry = { epssScore: number; epssPercentile: number };
  type VulncheckHit = {
    cveId: string;
    observedAt: Date;
    evidence: string | null;
    source: string;
  };

  return {
    lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    probe: vi.fn(async () => ({ state: 'up' as const, latencyMs: 8, banner: null })),
    match: vi.fn(
      async (_input: { port: number }, _context?: unknown): Promise<MatcherHit[]> => [],
    ),
    createMatcherContext: vi.fn(() => ({ queryOsv: vi.fn(async () => []) })),
    fetchCve: vi.fn(async (_cveId: string, _apiKey?: string): Promise<CveMetadata | null> => null),
    fetchEpssBatch: vi.fn(async (_cveIds: string[]) => new Map<string, EpssEntry>()),
    fetchKevCatalog: vi.fn(async () => new Map<string, { dateAdded: string }>()),
    fetchVulncheckBatch: vi.fn(
      async (_cveIds: string[], _apiToken?: string) => new Map<string, VulncheckHit>(),
    ),
    scanCreate: vi.fn(async () => ({ id: 'scan-1' })),
    scanUpdate: vi.fn(async () => ({ id: 'scan-1' })),
    assetCreate: vi.fn(async (args: { data: { port: number } }) => ({ id: `asset-${args.data.port}` })),
    cveEntryFindUnique: vi.fn(async () => null),
    cveEntryCreate: vi.fn(async () => ({ cveId: 'CVE-2000-0000' })),
    findingCreate: vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: `finding-${String(args.data.cveId)}`,
      ...args.data,
    })),
    vulncheckHitUpsert: vi.fn(async () => ({})),
    threatIntelEventCreateMany: vi.fn(async () => ({ count: 0 })),
  };
});

vi.mock('server-only', () => ({}));
vi.mock('node:dns/promises', () => ({ lookup: scannerMocks.lookup }));
vi.mock('@/lib/business/scanner/tcp-probe', () => ({ probe: scannerMocks.probe }));
vi.mock('@/lib/business/scanner/matcher', () => ({
  match: scannerMocks.match,
  createMatcherContext: scannerMocks.createMatcherContext,
}));
vi.mock('@/lib/business/scanner/cve-feed', () => ({ fetchCve: scannerMocks.fetchCve }));
vi.mock('@/lib/business/scanner/epss', () => ({ fetchEpssBatch: scannerMocks.fetchEpssBatch }));
vi.mock('@/lib/business/scanner/kev', () => ({ fetchKevCatalog: scannerMocks.fetchKevCatalog }));
vi.mock('@/lib/business/scanner/vulncheck', () => ({
  fetchVulncheckBatch: scannerMocks.fetchVulncheckBatch,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    scan: { create: scannerMocks.scanCreate, update: scannerMocks.scanUpdate },
    asset: { create: scannerMocks.assetCreate },
    cveEntry: {
      findUnique: scannerMocks.cveEntryFindUnique,
      create: scannerMocks.cveEntryCreate,
    },
    vulnerabilityFinding: { create: scannerMocks.findingCreate },
    vulncheckHit: { upsert: scannerMocks.vulncheckHitUpsert },
    threatIntelEvent: { createMany: scannerMocks.threatIntelEventCreateMany },
  },
}));
vi.mock('@/lib/env', () => ({ env: { NVD_API_KEY: undefined, VULNCHECK_API_TOKEN: undefined } }));

import { runScan, UnsafeScanTargetError } from '@/lib/business/scanner/run-scan';
import type { ScanCreate } from '@/lib/contracts/scan';

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

beforeEach(() => {
  vi.resetAllMocks();
  scannerMocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  scannerMocks.probe.mockResolvedValue({ state: 'up', latencyMs: 8, banner: null });
  scannerMocks.match.mockResolvedValue([]);
  scannerMocks.fetchCve.mockResolvedValue(null);
  scannerMocks.fetchEpssBatch.mockResolvedValue(new Map());
  scannerMocks.fetchKevCatalog.mockResolvedValue(new Map());
  scannerMocks.fetchVulncheckBatch.mockResolvedValue(new Map());
  scannerMocks.scanCreate.mockResolvedValue({ id: 'scan-1' });
  scannerMocks.scanUpdate.mockResolvedValue({ id: 'scan-1' });
  scannerMocks.assetCreate.mockImplementation(async ({ data }) => ({ id: `asset-${data.port}` }));
  scannerMocks.cveEntryFindUnique.mockResolvedValue(null);
  scannerMocks.cveEntryCreate.mockResolvedValue({ cveId: 'CVE-2000-0000' });
  scannerMocks.findingCreate.mockImplementation(async ({ data }) => ({
    id: `finding-${String(data.cveId)}`,
    ...data,
  }));
  scannerMocks.vulncheckHitUpsert.mockResolvedValue({});
  scannerMocks.threatIntelEventCreateMany.mockResolvedValue({ count: 0 });
});

describe('runScan vulnerability checks', () => {
  it('runs per-asset checks concurrently and completes with findings from checks that succeed', async () => {
    let activeChecks = 0;
    let maxActiveChecks = 0;
    scannerMocks.match.mockImplementation(async ({ port }) => {
      activeChecks += 1;
      maxActiveChecks = Math.max(maxActiveChecks, activeChecks);
      try {
        if (port === 22) {
          await wait(30);
          throw new Error('one check failed');
        }
        if (port === 80) {
          await wait(15);
          return [
            {
              cveId: 'CVE-2024-1000',
              severity: 'High',
              matchReason: 'Successful high severity check.',
            },
          ];
        }
        return [
          {
            cveId: 'CVE-2014-0160',
            severity: 'Critical',
            matchReason: 'Successful critical check.',
          },
        ];
      } finally {
        activeChecks -= 1;
      }
    });

    const input: ScanCreate = {
      target: 'scanme.example.org',
      ports: [22, 80, 443],
      mode: 'tcp-only',
    };
    const result = await runScan(input, { source: 'manual' });

    expect(maxActiveChecks).toBe(3);
    expect(scannerMocks.probe).toHaveBeenCalledWith('93.184.216.34', 22, 1_500);
    expect(result.status).toBe('completed');
    expect(result.assets.map((asset) => asset.port)).toEqual([22, 80, 443]);
    expect(result.findings.map((finding) => finding.cveId)).toEqual([
      'CVE-2014-0160',
      'CVE-2024-1000',
    ]);
    expect(result.findings[0]).toMatchObject({
      id: 'finding-CVE-2014-0160',
      assetId: 'asset-443',
      severity: 'Critical',
      matchReason: 'Successful critical check.',
      components: {
        cvssSource: 'severity',
        cvssContribution: 5.7,
      },
    });
    expect(scannerMocks.scanUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'completed' }) }),
    );
  });

  it('keeps successful threat-intel results when another source fails', async () => {
    scannerMocks.match.mockResolvedValue([
      {
        cveId: 'CVE-2024-2000',
        severity: 'High',
        matchReason: 'Seeded high severity check.',
      },
    ]);
    scannerMocks.fetchEpssBatch.mockResolvedValue(
      new Map([['CVE-2024-2000', { epssScore: 0.75, epssPercentile: 0.9 }]]),
    );
    scannerMocks.fetchKevCatalog.mockRejectedValue(new Error('catalog unavailable'));

    const input: ScanCreate = {
      target: 'scanme.example.org',
      ports: [443],
      mode: 'tcp-only',
    };
    const result = await runScan(input, { source: 'manual' });

    expect(result.status).toBe('completed');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      cveId: 'CVE-2024-2000',
      assetId: 'asset-443',
      epssScore: 0.75,
      epssPercentile: 0.9,
      kevListed: false,
    });
  });

  it('keeps repeated-check findings attached to each asset while sharing scan metadata context', async () => {
    scannerMocks.match.mockResolvedValue([
      {
        cveId: 'CVE-2024-3000',
        severity: 'High',
        matchReason: 'Repeated package metadata check.',
      },
    ]);
    scannerMocks.cveEntryFindUnique.mockResolvedValue({ cvssScore: 8.1, severity: 'High' });
    scannerMocks.findingCreate.mockImplementation(async ({ data }) => ({
      id: `finding-${String(data.assetId)}`,
      ...data,
    }));

    const result = await runScan(
      {
        target: 'scanme.example.org',
        ports: [80, 443],
        mode: 'tcp-only',
      },
      { source: 'manual' },
    );

    expect(scannerMocks.createMatcherContext).toHaveBeenCalledTimes(1);
    const firstContext = scannerMocks.match.mock.calls[0]?.[1];
    expect(firstContext).toBeDefined();
    expect(scannerMocks.match.mock.calls[1]?.[1]).toBe(firstContext);
    expect(scannerMocks.cveEntryFindUnique).toHaveBeenCalledTimes(1);
    expect(result.findings.map(({ assetId, cveId, severity, matchReason }) => ({
      assetId,
      cveId,
      severity,
      matchReason,
    }))).toEqual([
      {
        assetId: 'asset-80',
        cveId: 'CVE-2024-3000',
        severity: 'High',
        matchReason: 'Repeated package metadata check.',
      },
      {
        assetId: 'asset-443',
        cveId: 'CVE-2024-3000',
        severity: 'High',
        matchReason: 'Repeated package metadata check.',
      },
    ]);
    expect(scannerMocks.findingCreate.mock.calls.map(([{ data }]) => ({
      assetId: data.assetId,
      cveId: data.cveId,
      severity: data.severity,
      matchReason: data.matchReason,
    }))).toEqual([
      {
        assetId: 'asset-80',
        cveId: 'CVE-2024-3000',
        severity: 'High',
        matchReason: 'Repeated package metadata check.',
      },
      {
        assetId: 'asset-443',
        cveId: 'CVE-2024-3000',
        severity: 'High',
        matchReason: 'Repeated package metadata check.',
      },
    ]);
  });

  it('rejects private DNS answers before creating a scan or opening a probe', async () => {
    scannerMocks.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const input: ScanCreate = {
      target: 'private.example.org',
      ports: [443],
      mode: 'tcp-only',
    };

    await expect(runScan(input)).rejects.toBeInstanceOf(UnsafeScanTargetError);
    expect(scannerMocks.scanCreate).not.toHaveBeenCalled();
    expect(scannerMocks.probe).not.toHaveBeenCalled();
  });
});
