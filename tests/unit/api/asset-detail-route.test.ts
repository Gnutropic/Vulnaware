// @vitest-environment node
// @polsia:user-owned — Workspace authorization coverage for asset detail.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  requireTeamRoleMock,
  resolveDashboardWorkspaceContextMock,
  loadAssetDetailMock,
  setRequestAuthMock,
} = vi.hoisted(() => ({
  requireTeamRoleMock: vi.fn(),
  resolveDashboardWorkspaceContextMock: vi.fn(),
  loadAssetDetailMock: vi.fn(),
  setRequestAuthMock: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/team-auth', () => ({ requireTeamRole: requireTeamRoleMock }));
vi.mock('@/lib/business/dashboard-workspace-context', () => ({
  resolveDashboardWorkspaceContext: resolveDashboardWorkspaceContextMock,
}));
vi.mock('@/lib/business/assets-detail', () => ({ loadAssetDetail: loadAssetDetailMock }));
vi.mock('@/lib/logging/with-request', () => ({
  setRequestAuth: setRequestAuthMock,
  withApiRequest: (_request: Request, handler: () => Promise<Response>) => handler(),
}));

import { GET } from '@/app/api/assets/[host]/route';

const context = {
  user: { id: 'user-1', role: 'user' },
  membership: { id: 'membership-1', userId: 'user-1', teamId: 'team-active', role: 'admin' },
  team: { id: 'team-active', name: 'Active workspace' },
};

function makeRequest(host: string) {
  return GET(new Request(`http://localhost/api/assets/${host}`), {
    params: Promise.resolve({ host }),
  });
}

describe('GET /api/assets/[host]', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requireTeamRoleMock.mockResolvedValue(context);
    resolveDashboardWorkspaceContextMock.mockResolvedValue({ workspaceId: 'team-active' });
    loadAssetDetailMock.mockResolvedValue({ alerts: { total: 0 } });
  });

  it('keeps missing and cross-workspace hosts opaque while passing the active workspace scope', async () => {
    const response = await makeRequest('Other.Example.Invalid');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'not_found' });
    expect(loadAssetDetailMock).toHaveBeenCalledWith('team-active', 'other.example.invalid');
    expect(setRequestAuthMock).toHaveBeenCalledWith({ userId: 'user-1', teamId: 'team-active' });
  });

  it('does not read asset detail for anonymous callers', async () => {
    requireTeamRoleMock.mockRejectedValue(Response.json({ error: 'Unauthorized' }, { status: 401 }));

    const response = await makeRequest('asset.example.invalid');

    expect(response.status).toBe(401);
    expect(loadAssetDetailMock).not.toHaveBeenCalled();
  });
});
