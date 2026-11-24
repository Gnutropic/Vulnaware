// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const routeMocks = vi.hoisted(() => ({
  requireTeamRead: vi.fn(),
  requireTeamRole: vi.fn(),
  scanFindMany: vi.fn(),
  scanFindUnique: vi.fn(),
  scanCount: vi.fn(),
  cveEntryFindMany: vi.fn(),
  vulnerabilityFindingFindMany: vi.fn(),
  runScan: vi.fn(),
  recordTrialFunnelStep: vi.fn(),
  UnsafeScanTargetError: class extends Error {
    constructor() {
      super('Target must resolve only to a public, routable address.');
    }
  },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/team-auth', () => ({
  requireTeamRead: routeMocks.requireTeamRead,
  requireTeamRole: routeMocks.requireTeamRole,
}));
vi.mock('@/lib/business/scanner/run-scan', () => ({
  runScan: routeMocks.runScan,
  UnsafeScanTargetError: routeMocks.UnsafeScanTargetError,
}));
vi.mock('@/lib/business/analytics', () => ({
  recordTrialFunnelStep: routeMocks.recordTrialFunnelStep,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    scan: {
      findMany: routeMocks.scanFindMany,
      findUnique: routeMocks.scanFindUnique,
      count: routeMocks.scanCount,
    },
    cveEntry: { findMany: routeMocks.cveEntryFindMany },
    vulnerabilityFinding: { findMany: routeMocks.vulnerabilityFindingFindMany },
  },
}));
vi.mock('@/lib/env', () => ({ env: { TRIAL_SAMPLE_TARGET_HOST: 'sample.vulnaware.invalid' } }));

import { GET as getScans, POST } from '@/app/api/scan/route';
import { UnsafeScanTargetError } from '@/lib/business/scanner/run-scan';

const memberContext = {
  user: { id: 'user-1', email: 'member@example.test' },
  membership: { id: 'membership-1', userId: 'user-1', teamId: 'team-1', role: 'member' },
  team: { id: 'team-1', name: 'Test workspace' },
};

async function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://test/api/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  routeMocks.requireTeamRead.mockResolvedValue(memberContext);
  routeMocks.requireTeamRole.mockResolvedValue(memberContext);
  routeMocks.scanFindMany.mockResolvedValue([]);
  routeMocks.scanFindUnique.mockResolvedValue({
    id: 'scan-1',
    target: '8.8.8.8',
    mode: 'tcp-only',
    status: 'completed',
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
    finishedAt: new Date('2026-01-01T00:00:05.000Z'),
    teamId: 'team-1',
    source: 'manual',
    assets: [],
    findings: [],
  });
  routeMocks.scanCount.mockResolvedValue(1);
  routeMocks.cveEntryFindMany.mockResolvedValue([]);
  routeMocks.vulnerabilityFindingFindMany.mockResolvedValue([]);
  routeMocks.runScan.mockResolvedValue({
    id: 'scan-1',
    target: '8.8.8.8',
    status: 'completed',
    findings: [],
    assets: [],
  });
  routeMocks.recordTrialFunnelStep.mockResolvedValue(undefined);
});

describe('POST /api/scan access and input limits', () => {
  it('requires a workspace member before creating a scan', async () => {
    routeMocks.requireTeamRole.mockRejectedValueOnce(
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
    );

    const response = await post({ target: '8.8.8.8', ports: [443] });

    expect(response.status).toBe(401);
    expect(routeMocks.requireTeamRole).toHaveBeenCalledWith('member');
    expect(routeMocks.scanCount).not.toHaveBeenCalled();
    expect(routeMocks.runScan).not.toHaveBeenCalled();
  });

  it('accepts a public target and the five-port allowlist for an authorized member', async () => {
    const response = await post({
      target: '8.8.8.8',
      ports: [22, 80, 443, 8080, 8443],
    });

    expect(response.status).toBe(201);
    expect(routeMocks.requireTeamRole).toHaveBeenCalledWith('member');
    expect(routeMocks.runScan).toHaveBeenCalledWith(
      { target: '8.8.8.8', ports: [22, 80, 443, 8080, 8443], mode: 'tcp-only' },
      { teamId: 'team-1', source: 'manual' },
    );
  });

  it.each([
    ['private IPv4', '127.0.0.1', [443]],
    ['private IPv4 range', '10.0.0.1', [443]],
    ['IPv4-mapped private address', '::ffff:127.0.0.1', [443]],
    ['localhost', 'localhost', [443]],
    ['no ports', 'scanme.example.org', []],
    ['too many ports', 'scanme.example.org', [22, 80, 443, 8080, 8443, 22]],
    ['non-allowlisted port', 'scanme.example.org', [25]],
  ])('rejects %s with the existing validation response', async (_label, target, ports) => {
    const response = await post({ target, ports });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toHaveProperty('errors');
    expect(routeMocks.runScan).not.toHaveBeenCalled();
  });

  it('keeps scan-level operational errors mapped to 502', async () => {
    routeMocks.runScan.mockRejectedValueOnce(new Error('scanner unavailable'));

    const response = await post({ target: '8.8.8.8', ports: [443] });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: 'scan_failed' });
  });

  it('maps a non-public DNS answer to the target validation response', async () => {
    routeMocks.runScan.mockRejectedValueOnce(new UnsafeScanTargetError());

    const response = await post({ target: 'private.example.org', ports: [443] });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      errors: { target: 'Target must resolve only to a public, routable address.' },
    });
  });
});

describe('GET /api/scan access', () => {
  it('limits the scan list to the authorized workspace', async () => {
    const response = await getScans();

    expect(response.status).toBe(200);
    expect(routeMocks.requireTeamRead).toHaveBeenCalledOnce();
    expect(routeMocks.scanFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teamId: 'team-1' } }),
    );
  });

  it('returns 403 when a member requests a scan owned by another workspace', async () => {
    routeMocks.scanFindUnique.mockResolvedValueOnce({
      id: 'scan-other-team',
      target: '8.8.8.8',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      finishedAt: new Date('2026-01-01T00:00:05.000Z'),
      teamId: 'team-2',
      source: 'manual',
      assets: [],
      findings: [],
    });
    const { GET } = await import('@/app/api/scan/[id]/route');

    const response = await GET(new Request('http://test/api/scan/scan-other-team'), {
      params: Promise.resolve({ id: 'scan-other-team' }),
    });

    expect(response.status).toBe(403);
    expect(routeMocks.requireTeamRead).toHaveBeenCalledOnce();
    expect(routeMocks.cveEntryFindMany).not.toHaveBeenCalled();
  });

  it('returns a scan to a member of its owning workspace', async () => {
    const { GET } = await import('@/app/api/scan/[id]/route');

    const response = await GET(new Request('http://test/api/scan/scan-1'), {
      params: Promise.resolve({ id: 'scan-1' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: 'scan-1' });
  });
});
