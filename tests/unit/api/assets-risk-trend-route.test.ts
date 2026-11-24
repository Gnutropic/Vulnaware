// @vitest-environment node
// Protected API coverage for GET /api/assets/[host]/risk-trend.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  requireTeamRoleMock,
  resolveDashboardWorkspaceContextMock,
  loadAssetRiskTrendMock,
  setRequestAuthMock,
} = vi.hoisted(() => ({
  requireTeamRoleMock: vi.fn(),
  resolveDashboardWorkspaceContextMock: vi.fn(),
  loadAssetRiskTrendMock: vi.fn(),
  setRequestAuthMock: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/team-auth', () => ({ requireTeamRole: requireTeamRoleMock }));
vi.mock('@/lib/business/dashboard-workspace-context', () => ({
  resolveDashboardWorkspaceContext: resolveDashboardWorkspaceContextMock,
}));
vi.mock('@/lib/business/assets-risk-trend', () => ({ loadAssetRiskTrend: loadAssetRiskTrendMock }));
vi.mock('@/lib/logging/with-request', () => ({
  setRequestAuth: setRequestAuthMock,
  withApiRequest: (_request: Request, handler: () => Promise<Response>) => handler(),
}));

import { GET } from '@/app/api/assets/[host]/risk-trend/route';

const context = {
  user: { id: 'user-1', role: 'user' },
  membership: { id: 'membership-1', userId: 'user-1', teamId: 'team-active', role: 'admin' },
  team: { id: 'team-active', name: 'Active workspace' },
};

function makeRequest(host: string) {
  return GET(new Request(`http://localhost/api/assets/${host}/risk-trend`), {
    params: Promise.resolve({ host }),
  });
}

async function readResponse(response: Response) {
  return { status: response.status, body: await response.json() };
}

describe('GET /api/assets/[host]/risk-trend', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requireTeamRoleMock.mockResolvedValue(context);
    resolveDashboardWorkspaceContextMock.mockResolvedValue({ workspaceId: 'team-active' });
    loadAssetRiskTrendMock.mockResolvedValue({
      host: 'server.example.invalid',
      series: [
        { scannedAt: '2026-09-10T09:30:00.000Z', score: 6.25 },
        { scannedAt: '2026-09-28T18:15:00.000Z', score: 8.5 },
      ],
    });
  });

  it('returns the validated dated series scoped to the authenticated team and normalized host', async () => {
    const response = await makeRequest('  Server.Example.Invalid  ');

    expect(await readResponse(response)).toEqual({
      status: 200,
      body: {
        host: 'server.example.invalid',
        series: [
          { scannedAt: '2026-09-10T09:30:00.000Z', score: 6.25 },
          { scannedAt: '2026-09-28T18:15:00.000Z', score: 8.5 },
        ],
      },
    });
    expect(requireTeamRoleMock).toHaveBeenCalledWith('member');
    expect(loadAssetRiskTrendMock).toHaveBeenCalledWith(
      'team-active',
      'server.example.invalid',
      expect.any(Date),
    );
    expect(setRequestAuthMock).toHaveBeenCalledWith({ userId: 'user-1', teamId: 'team-active' });
  });

  it('returns 401 to anonymous callers without reading history', async () => {
    requireTeamRoleMock.mockRejectedValue(Response.json({ error: 'Unauthorized' }, { status: 401 }));

    const response = await makeRequest('server.example.invalid');

    expect(response.status).toBe(401);
    expect(loadAssetRiskTrendMock).not.toHaveBeenCalled();
  });

  it('returns 404 when there is no active workspace without reading history', async () => {
    resolveDashboardWorkspaceContextMock.mockResolvedValue(null);

    const response = await makeRequest('server.example.invalid');

    expect(await readResponse(response)).toEqual({
      status: 404,
      body: { error: 'No active workspace' },
    });
    expect(loadAssetRiskTrendMock).not.toHaveBeenCalled();
  });

  it('rejects malformed host path segments before reading history', async () => {
    const response = await makeRequest('bad%2Fhost');

    expect(response.status).toBe(400);
    expect(loadAssetRiskTrendMock).not.toHaveBeenCalled();
  });

  it('scopes history to the resolved active workspace, not a membership default', async () => {
    loadAssetRiskTrendMock.mockResolvedValue({ host: 'server.example.invalid', series: [] });
    resolveDashboardWorkspaceContextMock.mockResolvedValue({ workspaceId: 'team-selected' });

    const response = await makeRequest('server.example.invalid');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ host: 'server.example.invalid', series: [] });
    expect(loadAssetRiskTrendMock).toHaveBeenCalledWith(
      'team-selected',
      'server.example.invalid',
      expect.any(Date),
    );
    expect(loadAssetRiskTrendMock).not.toHaveBeenCalledWith(
      context.membership.teamId,
      expect.any(String),
      expect.any(Date),
    );
  });

  it('returns 200 with an empty series when no scored scans qualify', async () => {
    loadAssetRiskTrendMock.mockResolvedValue({ host: 'server.example.invalid', series: [] });

    const response = await makeRequest('server.example.invalid');

    expect(await readResponse(response)).toEqual({
      status: 200,
      body: { host: 'server.example.invalid', series: [] },
    });
  });

  it('preserves the generic 500 response when the data query fails', async () => {
    loadAssetRiskTrendMock.mockRejectedValue(new Error('query failed'));

    expect(await readResponse(await makeRequest('server.example.invalid'))).toEqual({
      status: 500,
      body: { error: 'Internal Server Error' },
    });
  });
});
