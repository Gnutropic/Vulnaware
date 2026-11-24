// @vitest-environment node
// Active-workspace authorization coverage for GET /api/alerts/[id].

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  requireAlertWorkspaceMemberMock,
  alertFindFirstMock,
  scanFindFirstMock,
  notificationFindUniqueMock,
  cveEntryFindUniqueMock,
  workspaceMemberFindFirstMock,
  userFindUniqueMock,
  lastActivityMock,
  setRequestAuthMock,
} = vi.hoisted(() => ({
  requireAlertWorkspaceMemberMock: vi.fn(),
  alertFindFirstMock: vi.fn(),
  scanFindFirstMock: vi.fn(),
  notificationFindUniqueMock: vi.fn(),
  cveEntryFindUniqueMock: vi.fn(),
  workspaceMemberFindFirstMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  lastActivityMock: vi.fn(),
  setRequestAuthMock: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/business/alert-workspace-access', () => ({
  requireAlertWorkspaceMember: requireAlertWorkspaceMemberMock,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    alert: { findFirst: alertFindFirstMock },
    scan: { findFirst: scanFindFirstMock },
    teamNotificationConfig: { findUnique: notificationFindUniqueMock },
    cveEntry: { findUnique: cveEntryFindUniqueMock },
    workspaceMember: { findFirst: workspaceMemberFindFirstMock },
    user: { findUnique: userFindUniqueMock },
  },
}));
vi.mock('@/lib/business/alerts-activity', () => ({
  computeAlertLastActivityAtForOne: lastActivityMock,
}));
vi.mock('@/lib/logging/with-request', () => ({
  setRequestAuth: setRequestAuthMock,
  withApiRequest: (_request: Request, handler: () => Promise<Response>) => handler(),
}));

import { GET } from '@/app/api/alerts/[id]/route';

const memberUser = { id: 'user-1', role: 'user' };
const activeWorkspaceContext = {
  workspaceId: 'workspace-2',
  workspaceMemberId: 'workspace-member-2',
};
const createdAt = new Date('2026-09-01T12:00:00.000Z');

function makeAlert() {
  return {
    id: 'alert-1',
    teamId: 'workspace-2',
    findingId: 'finding-1',
    severity: 'critical',
    status: 'open',
    statusChangedAt: null,
    source: 'kev',
    ownerId: 'workspace-member-2',
    createdAt,
    acknowledgedAt: null,
    snoozedUntil: null,
    falsePositiveReason: null,
    closedAt: null,
    closedBy: null,
    closingNote: null,
    reopenedAt: null,
    reopenedBy: null,
    reopenReason: null,
    remediatedAt: null,
    remediatedByEmail: null,
    finding: {
      cveId: 'CVE-2026-82005',
      priorityScore: 8.125,
      lastRescoreAt: null,
      asset: {
        id: 'asset-1',
        host: 'customer-workspace-2.example.invalid',
        ip: '192.0.2.25',
        port: 443,
        protocol: 'tcp',
      },
      scan: { source: 'manual' },
    },
    explanation: null,
  };
}

function makeRequest() {
  return GET(new Request('http://localhost/api/alerts/alert-1'), {
    params: Promise.resolve({ id: 'alert-1' }),
  });
}

async function readResponse(response: Response) {
  return { status: response.status, body: await response.json() };
}

describe('GET /api/alerts/[id]', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requireAlertWorkspaceMemberMock.mockResolvedValue({
      user: memberUser,
      ...activeWorkspaceContext,
    });
    alertFindFirstMock.mockResolvedValue(null);
    notificationFindUniqueMock.mockResolvedValue(null);
    cveEntryFindUniqueMock.mockResolvedValue({
      cvssScore: 9.1,
      description: 'Synthetic alert description.',
    });
    workspaceMemberFindFirstMock.mockResolvedValue({ userId: 'owner-1' });
    userFindUniqueMock.mockResolvedValue({ name: 'Workspace member' });
    lastActivityMock.mockResolvedValue(null);
    scanFindFirstMock.mockResolvedValue(null);
  });

  it('returns 401 to anonymous callers before reading alerts', async () => {
    requireAlertWorkspaceMemberMock.mockRejectedValue(
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
    );

    const response = await makeRequest();

    expect(response.status).toBe(401);
    expect(alertFindFirstMock).not.toHaveBeenCalled();
    expect(requireAlertWorkspaceMemberMock).toHaveBeenCalled();
  });

  it('returns the existing detail envelope for an active workspace member', async () => {
    alertFindFirstMock.mockResolvedValue(makeAlert());
    notificationFindUniqueMock.mockResolvedValue({ id: 'notification-1' });
    scanFindFirstMock.mockResolvedValue({
      status: 'completed',
      startedAt: new Date('2026-09-01T11:30:00.000Z'),
    });

    const response = await makeRequest();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      id: 'alert-1',
      teamId: 'workspace-2',
      severity: 'critical',
      cveId: 'CVE-2026-82005',
      description: 'Synthetic alert description.',
      asset: {
        host: 'customer-workspace-2.example.invalid',
        riskScore: 8.125,
        latestScanStatus: 'completed',
        latestScanAt: '2026-09-01T11:30:00.000Z',
        hasCompletedScan: true,
      },
      webhookConfigured: true,
      me: { isAssignee: true },
      lastExplainedAt: null,
      lastExplanationText: null,
    });
    expect(alertFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'alert-1', teamId: 'workspace-2' } }),
    );
    expect(scanFindFirstMock).toHaveBeenCalledWith({
      where: {
        teamId: 'workspace-2',
        assets: { some: { host: 'customer-workspace-2.example.invalid' } },
      },
      orderBy: { startedAt: 'desc' },
      select: { status: true, startedAt: true },
    });
    expect(scanFindFirstMock).toHaveBeenCalledWith({
      where: {
        teamId: 'workspace-2',
        status: 'completed',
        assets: { some: { host: 'customer-workspace-2.example.invalid' } },
      },
      orderBy: { startedAt: 'desc' },
      select: { id: true },
    });
    expect(setRequestAuthMock).toHaveBeenCalledWith({ userId: 'user-1', teamId: 'workspace-2' });
  });

  it('keeps asset context nullable when the asset and scan are unavailable', async () => {
    alertFindFirstMock.mockResolvedValue({
      ...makeAlert(),
      finding: { ...makeAlert().finding, asset: null, priorityScore: null },
    });

    const response = await makeRequest();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.asset).toMatchObject({
      id: '',
      host: '',
      riskScore: null,
      latestScanStatus: null,
      latestScanAt: null,
      hasCompletedScan: false,
    });
    expect(scanFindFirstMock).not.toHaveBeenCalled();
  });

  it('keeps legacy scan outcomes unavailable without failing the alert', async () => {
    alertFindFirstMock.mockResolvedValue(makeAlert());
    scanFindFirstMock.mockImplementation((query: { where: { status?: string } }) =>
      Promise.resolve(
        query.where.status === 'completed'
          ? null
          : {
              status: 'legacy_status',
              startedAt: new Date('2026-09-01T11:30:00.000Z'),
            },
      ),
    );

    const response = await makeRequest();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.asset).toMatchObject({
      riskScore: 8.125,
      latestScanStatus: null,
      latestScanAt: '2026-09-01T11:30:00.000Z',
      hasCompletedScan: false,
    });
  });

  it('selects the newest matching scan from the active workspace only', async () => {
    alertFindFirstMock.mockResolvedValue(makeAlert());
    const scans = [
      {
        id: 'workspace-2-completed',
        teamId: 'workspace-2',
        host: 'customer-workspace-2.example.invalid',
        status: 'completed',
        startedAt: new Date('2026-09-01T11:30:00.000Z'),
      },
      {
        id: 'workspace-2-running',
        teamId: 'workspace-2',
        host: 'customer-workspace-2.example.invalid',
        status: 'running',
        startedAt: new Date('2026-09-01T12:30:00.000Z'),
      },
      {
        id: 'workspace-1-newest',
        teamId: 'workspace-1',
        host: 'customer-workspace-2.example.invalid',
        status: 'completed',
        startedAt: new Date('2026-09-01T13:30:00.000Z'),
      },
    ];
    scanFindFirstMock.mockImplementation(
      (query: {
        where: { teamId: string; status?: string; assets: { some: { host: string } } };
      }) => {
        const selected = scans
          .filter(
            (scan) =>
              scan.teamId === query.where.teamId &&
              scan.host === query.where.assets.some.host &&
              (!query.where.status || scan.status === query.where.status),
          )
          .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())[0];

        if (!selected) return Promise.resolve(null);
        return Promise.resolve(
          query.where.status === 'completed'
            ? { id: selected.id }
            : { status: selected.status, startedAt: selected.startedAt },
        );
      },
    );

    const response = await makeRequest();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.asset).toMatchObject({
      latestScanStatus: 'running',
      latestScanAt: '2026-09-01T12:30:00.000Z',
      hasCompletedScan: true,
    });
    expect(scanFindFirstMock).toHaveBeenCalledTimes(2);
    expect(scanFindFirstMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: expect.objectContaining({ teamId: 'workspace-2' }) }),
    );
    expect(scanFindFirstMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ teamId: 'workspace-2', status: 'completed' }),
      }),
    );
  });

  it('returns an opaque 404 for a signed-in viewer without member-level access', async () => {
    requireAlertWorkspaceMemberMock.mockRejectedValue(
      Response.json({ error: 'not_found' }, { status: 404 }),
    );

    const response = await makeRequest();

    expect(await readResponse(response)).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(alertFindFirstMock).not.toHaveBeenCalled();
  });

  it('returns an opaque 404 for an owner-only workspace without an active roster row', async () => {
    requireAlertWorkspaceMemberMock.mockRejectedValue(
      Response.json({ error: 'not_found' }, { status: 404 }),
    );

    const response = await makeRequest();

    expect(await readResponse(response)).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(alertFindFirstMock).not.toHaveBeenCalled();
  });

  it('does not let an admin role replace an active workspace roster row', async () => {
    requireAlertWorkspaceMemberMock.mockRejectedValue(
      Response.json({ error: 'not_found' }, { status: 404 }),
    );

    const response = await makeRequest();

    expect(await readResponse(response)).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(alertFindFirstMock).not.toHaveBeenCalled();
  });

  it.each([
    { scenario: 'a cross-workspace alert', row: { ...makeAlert(), teamId: 'workspace-1' } },
    { scenario: 'a missing alert', row: null },
  ])('returns the same scoped 404 for $scenario', async ({ row }) => {
    alertFindFirstMock.mockImplementation(
      async (args: { where: { id: string; teamId: string } }) =>
        row?.id === args.where.id && row.teamId === args.where.teamId ? row : null,
    );

    const result = await readResponse(await makeRequest());

    expect(result).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(alertFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'alert-1', teamId: 'workspace-2' } }),
    );
    expect(JSON.stringify(result.body)).not.toContain('customer-workspace');
  });

  it('returns a generic 500 when the workspace-member guard fails', async () => {
    requireAlertWorkspaceMemberMock.mockRejectedValue(
      Response.json({ error: 'Internal Server Error' }, { status: 500 }),
    );

    const response = await makeRequest();

    expect(await readResponse(response)).toEqual({
      status: 500,
      body: { error: 'Internal Server Error' },
    });
    expect(alertFindFirstMock).not.toHaveBeenCalled();
  });

  it('returns a generic 500 when the scoped alert query fails', async () => {
    alertFindFirstMock.mockRejectedValue(new Error('database query failed'));

    const response = await makeRequest();

    expect(await readResponse(response)).toEqual({
      status: 500,
      body: { error: 'Internal Server Error' },
    });
  });
});
