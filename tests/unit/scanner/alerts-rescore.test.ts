// @vitest-environment node
// Unit tests for the live-rescore orchestrator's alert-write seam.
// Every test mocks the three intel feeds + prisma; the alerts helper runs
// for real so we exercise its decision gate end-to-end.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const findingFindMany = vi.fn();
const cveEntryFindMany = vi.fn();
const scanFindManyMock = vi.fn();
const alertCreate = vi.fn();
const prismaTransaction = vi.fn();

const transactionClient = {
  vulnerabilityFinding: { update: vi.fn() },
  threatIntelEvent: { createMany: vi.fn() },
  vulncheckHit: { upsert: vi.fn() },
  intelFeedCursor: { upsert: vi.fn() },
};

vi.mock('@/lib/db', () => ({
  prisma: {
    vulnerabilityFinding: {
      findMany: findingFindMany,
    },
    cveEntry: {
      findMany: cveEntryFindMany,
    },
    $transaction: (fn: (tx: typeof transactionClient) => Promise<unknown>) => prismaTransaction(fn),
    scan: { findMany: scanFindManyMock },
    alert: { create: alertCreate },
  },
}));

vi.mock('@/lib/env', () => ({
  env: { VULNCHECK_API_TOKEN: 'test-token' },
}));

vi.mock('@/lib/business/scanner/epss', () => ({
  fetchEpssBatch: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/business/scanner/kev', () => ({
  fetchKevCatalog: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/business/scanner/vulncheck', () => ({
  fetchVulncheckBatch: vi.fn(async () => new Map()),
}));

function makeScan(overrides: Record<string, unknown> = {}) {
  return {
    id: 'scan-1',
    teamId: 'team-1',
    ...overrides,
  };
}

function makeFinding(overrides: Record<string, unknown> = {}) {
  return {
    id: 'finding-1',
    cveId: 'CVE-2014-0160',
    severity: 'high',
    kevListed: false,
    vulncheckListed: false,
    ...overrides,
  };
}

function makeCveEntry(cveId: string) {
  return { cveId, cvssScore: 7.5, severity: 'high' };
}

beforeEach(() => {
  vi.resetModules();
  findingFindMany.mockReset();
  cveEntryFindMany.mockReset();
  prismaTransaction.mockReset();
  prismaTransaction.mockImplementation(async (fn) => {
    await fn(transactionClient);
  });
  scanFindManyMock.mockReset();
  alertCreate.mockReset();
  transactionClient.vulnerabilityFinding.update.mockReset();
  transactionClient.vulnerabilityFinding.update.mockResolvedValue({});
  transactionClient.threatIntelEvent.createMany.mockReset();
  transactionClient.threatIntelEvent.createMany.mockResolvedValue({ count: 0 });
  transactionClient.vulncheckHit.upsert.mockReset();
  transactionClient.vulncheckHit.upsert.mockResolvedValue({});
  transactionClient.intelFeedCursor.upsert.mockReset();
  transactionClient.intelFeedCursor.upsert.mockResolvedValue({});
});

async function runRescore(prevScore = 0) {
  const { rescoreByCveIds } = await import('@/lib/business/scanner/live-rescore');
  return rescoreByCveIds(
    [{ findingId: 'finding-1', cveId: 'CVE-2014-0160', prevScore, scanId: 'scan-1' }],
    { trigger: 'manual' },
  );
}

describe('live-rescore → alert seam', () => {
  it('Case A — fresh KEV transition writes one Alert row (source=kev)', async () => {
    findingFindMany.mockResolvedValue([makeFinding({ kevListed: false, vulncheckListed: false })]);
    cveEntryFindMany.mockResolvedValue([makeCveEntry('CVE-2014-0160')]);
    scanFindManyMock.mockResolvedValue([makeScan()]);
    const { fetchKevCatalog } = await import('@/lib/business/scanner/kev');
    (fetchKevCatalog as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Map([['CVE-2014-0160', { dateAdded: '2026-01-01' }]]),
    );
    alertCreate.mockResolvedValue({});

    await runRescore(0);

    expect(alertCreate).toHaveBeenCalledTimes(1);
    expect(alertCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        source: 'kev',
        teamId: 'team-1',
        findingId: 'finding-1',
      }),
    });
  });

  it('Case B — no-op rescore (already-KEV-listed + matching score) writes zero alert rows', async () => {
    findingFindMany.mockResolvedValue([makeFinding({ kevListed: true, vulncheckListed: false })]);
    cveEntryFindMany.mockResolvedValue([makeCveEntry('CVE-2014-0160')]);
    scanFindManyMock.mockResolvedValue([makeScan()]);
    const { fetchKevCatalog } = await import('@/lib/business/scanner/kev');
    (fetchKevCatalog as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Map([['CVE-2014-0160', { dateAdded: '2026-01-01' }]]),
    );

    // rescored priority with kev listed + cvss 7.5 + no epss = 6.5
    await runRescore(6.5);

    expect(alertCreate).not.toHaveBeenCalled();
  });

  it('Case C — fresh VulnCheck sighting writes one Alert row (source=vulncheck)', async () => {
    findingFindMany.mockResolvedValue([makeFinding({ kevListed: false, vulncheckListed: false })]);
    cveEntryFindMany.mockResolvedValue([makeCveEntry('CVE-2014-0160')]);
    scanFindManyMock.mockResolvedValue([makeScan()]);
    const { fetchVulncheckBatch } = await import('@/lib/business/scanner/vulncheck');
    (fetchVulncheckBatch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Map([
        [
          'CVE-2014-0160',
          {
            cveId: 'CVE-2014-0160',
            observedAt: new Date('2026-01-02T00:00:00Z'),
            evidence: 'poc',
            source: 'vulncheck-nvd-cve',
          },
        ],
      ]),
    );
    alertCreate.mockResolvedValue({});

    await runRescore(0);

    expect(alertCreate).toHaveBeenCalledTimes(1);
    expect(alertCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        source: 'vulncheck',
        teamId: 'team-1',
        findingId: 'finding-1',
      }),
    });
  });

  it('Case D — re-confirmed VulnCheck (already listed) writes zero alert rows', async () => {
    findingFindMany.mockResolvedValue([makeFinding({ kevListed: false, vulncheckListed: true })]);
    cveEntryFindMany.mockResolvedValue([makeCveEntry('CVE-2014-0160')]);
    scanFindManyMock.mockResolvedValue([makeScan()]);
    const { fetchVulncheckBatch } = await import('@/lib/business/scanner/vulncheck');
    (fetchVulncheckBatch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Map([
        [
          'CVE-2014-0160',
          {
            cveId: 'CVE-2014-0160',
            observedAt: new Date('2026-01-02T00:00:00Z'),
            evidence: null,
            source: 'vulncheck-nvd-cve',
          },
        ],
      ]),
    );

    // rescored score with vc listed + epss 0 (< floor 0.05) = 4.5 (no VC
    // boost). prevScore=4.5 → not bumped. Even if it had been, the helper
    // gate's `previousVc === false` requirement would still prevent an alert.
    await runRescore(4.5);

    expect(alertCreate).not.toHaveBeenCalled();
  });

  it('Case E — fire-and-forget: alert.create rejection does NOT throw out of rescore', async () => {
    findingFindMany.mockResolvedValue([makeFinding({ kevListed: false, vulncheckListed: false })]);
    cveEntryFindMany.mockResolvedValue([makeCveEntry('CVE-2014-0160')]);
    scanFindManyMock.mockResolvedValue([makeScan()]);
    const { fetchKevCatalog } = await import('@/lib/business/scanner/kev');
    (fetchKevCatalog as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Map([['CVE-2014-0160', { dateAdded: '2026-01-01' }]]),
    );
    // Force create to return a rejected promise — fire-and-forget must
    // swallow it via `.catch(() => {})` rather than propagating.
    alertCreate.mockRejectedValue(new Error('alert-write transient'));

    await expect(runRescore(0)).resolves.toBeDefined();
    expect(alertCreate).toHaveBeenCalled();
  });
});
