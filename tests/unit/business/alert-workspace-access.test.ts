// @vitest-environment node
// Regression coverage for the active-workspace alert authorization helper.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requireAuthMock, resolveWorkspaceContextMock, memberFindFirstMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  resolveWorkspaceContextMock: vi.fn(),
  memberFindFirstMock: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-auth', () => ({
  requireAuth: requireAuthMock,
}));
vi.mock('@/lib/business/dashboard-workspace-context', () => ({
  resolveDashboardWorkspaceContext: resolveWorkspaceContextMock,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    workspaceMember: { findFirst: memberFindFirstMock },
  },
}));

import { requireAlertWorkspaceMember } from '@/lib/business/alert-workspace-access';

const user = { id: 'user-1', role: 'user' };
const workspaceContext = {
  workspaceId: 'workspace-1',
  workspaceMemberId: 'member-1',
};

describe('requireAlertWorkspaceMember', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requireAuthMock.mockResolvedValue(user);
    resolveWorkspaceContextMock.mockResolvedValue(workspaceContext);
    memberFindFirstMock.mockResolvedValue({ role: 'member' });
  });

  it('propagates anonymous authorization failure before workspace reads', async () => {
    const unauthorized = Response.json({ error: 'Unauthorized' }, { status: 401 });
    requireAuthMock.mockRejectedValue(unauthorized);

    await expect(requireAlertWorkspaceMember()).rejects.toBe(unauthorized);

    expect(resolveWorkspaceContextMock).not.toHaveBeenCalled();
    expect(memberFindFirstMock).not.toHaveBeenCalled();
  });

  it('denies callers without an active workspace member row', async () => {
    resolveWorkspaceContextMock.mockResolvedValue(null);

    await expect(requireAlertWorkspaceMember()).rejects.toMatchObject({ status: 404 });

    expect(memberFindFirstMock).not.toHaveBeenCalled();
  });

  it.each([
    { role: 'viewer', label: 'viewer' },
    { role: null, label: 'missing role' },
  ])('denies a $label workspace role', async ({ role }) => {
    memberFindFirstMock.mockResolvedValue({ role });

    await expect(requireAlertWorkspaceMember()).rejects.toMatchObject({ status: 404 });
  });

  it.each(['member', 'admin'])('allows an active %s workspace member', async (role) => {
    memberFindFirstMock.mockResolvedValue({ role });

    await expect(requireAlertWorkspaceMember()).resolves.toEqual({
      user,
      ...workspaceContext,
    });
  });

  it('rechecks the authenticated user, active workspace, and active status together', async () => {
    await requireAlertWorkspaceMember();

    expect(memberFindFirstMock).toHaveBeenCalledWith({
      where: {
        id: 'member-1',
        userId: 'user-1',
        workspaceId: 'workspace-1',
        status: 'active',
      },
      select: { role: true },
    });
  });
});
