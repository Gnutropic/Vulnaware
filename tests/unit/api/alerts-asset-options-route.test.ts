// @vitest-environment node
// Active-workspace coverage for GET /api/alerts/asset-options.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const alertFindMany = vi.fn();
const requireTeamRoleMock = vi.fn();
const resolveDashboardWorkspaceContextMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: { alert: { findMany: alertFindMany } },
}));

vi.mock('@/lib/team-auth', () => ({
  requireTeamRole: requireTeamRoleMock,
}));

vi.mock('@/lib/business/dashboard-workspace-context', () => ({
  resolveDashboardWorkspaceContext: resolveDashboardWorkspaceContextMock,
}));

const workspaceAlerts = [
  {
    teamId: 'active-workspace',
    findingId: 'finding-active',
    finding: { asset: { host: 'active.example.invalid', port: 443, protocol: 'tcp' } },
  },
  {
    teamId: 'other-workspace',
    findingId: 'finding-other',
    finding: { asset: { host: 'other.example.invalid', port: 443, protocol: 'tcp' } },
  },
];

beforeEach(() => {
  vi.resetModules();
  alertFindMany.mockReset();
  requireTeamRoleMock.mockReset();
  resolveDashboardWorkspaceContextMock.mockReset();

  requireTeamRoleMock.mockResolvedValue({
    user: { id: 'user-1' },
    membership: { id: 'default-member', teamId: 'default-team' },
  });
  resolveDashboardWorkspaceContextMock.mockResolvedValue({
    workspaceId: 'active-workspace',
    workspaceMemberId: 'active-workspace-member',
  });
  alertFindMany.mockImplementation(async ({ where }: { where: { teamId: string } }) =>
    workspaceAlerts.filter((alert) => alert.teamId === where.teamId),
  );
});

describe('GET /api/alerts/asset-options', () => {
  it('returns asset options from only the validated active workspace', async () => {
    const { GET } = await import('@/app/api/alerts/asset-options/route');
    const response = await GET(new Request('http://test/api/alerts/asset-options'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [{ name: 'active.example.invalid:443/tcp', count: 1 }],
    });
    expect(alertFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { teamId: 'active-workspace', findingId: { not: 'manual' } },
      }),
    );
  });

  it('returns the no-active-workspace response without reading assets', async () => {
    resolveDashboardWorkspaceContextMock.mockResolvedValueOnce(null);

    const { GET } = await import('@/app/api/alerts/asset-options/route');
    const response = await GET(new Request('http://test/api/alerts/asset-options'));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'No active workspace' });
    expect(alertFindMany).not.toHaveBeenCalled();
  });
});
