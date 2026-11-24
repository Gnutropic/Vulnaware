// @vitest-environment node
// @polsia:user-owned — Authenticated workspace visibility and error coverage.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/workspaces/route';

const {
  requireAuthMock,
  workspaceMemberFindManyMock,
  workspaceFindManyMock,
  resolveActiveWorkspaceIdMock,
} = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  workspaceMemberFindManyMock: vi.fn(),
  workspaceFindManyMock: vi.fn(),
  resolveActiveWorkspaceIdMock: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-auth', () => ({ requireAuth: requireAuthMock }));
vi.mock('@/lib/db', () => ({
  prisma: {
    workspaceMember: { findMany: workspaceMemberFindManyMock },
    workspace: { findMany: workspaceFindManyMock },
  },
}));
vi.mock('@/lib/business/active-workspace', () => ({
  resolveActiveWorkspaceId: resolveActiveWorkspaceIdMock,
}));

const user = { id: 'user-1' };
const rosterRows = [
  { workspaceId: 'workspace-owned-and-member', userId: 'user-1', status: 'active' },
  { workspaceId: 'workspace-member-two', userId: 'user-1', status: 'active' },
  { workspaceId: 'workspace-invited', userId: 'user-1', status: 'invited' },
  { workspaceId: 'workspace-orphan', userId: 'user-1', status: 'active' },
  { workspaceId: 'workspace-inaccessible', userId: 'user-2', status: 'active' },
];

describe('GET /api/workspaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAuthMock.mockResolvedValue(user);
    workspaceMemberFindManyMock.mockImplementation(
      async (args: { where: { userId: string; status: string } }) =>
        rosterRows
          .filter((row) => row.userId === args.where.userId && row.status === args.where.status)
          .map(({ workspaceId }) => ({ workspaceId })),
    );
    workspaceFindManyMock.mockResolvedValue([
      { id: 'workspace-member-two', name: 'Member workspace' },
      { id: 'workspace-owned-and-member', name: 'Owned and shared workspace' },
      { id: 'workspace-owned-only', name: 'Owned workspace' },
    ]);
    resolveActiveWorkspaceIdMock.mockResolvedValue('workspace-member-two');
  });

  it('returns existing workspaces from active memberships or ownership only', async () => {
    const response = await GET(new Request('http://localhost/api/workspaces'));

    expect(response.status).toBe(200);
    const responseBody = (await response.json()) as {
      workspaces: { id: string; name: string }[];
      activeWorkspaceId: string | null;
    };
    expect(responseBody).toEqual({
      workspaces: [
        { id: 'workspace-member-two', name: 'Member workspace' },
        { id: 'workspace-owned-and-member', name: 'Owned and shared workspace' },
        { id: 'workspace-owned-only', name: 'Owned workspace' },
      ],
      activeWorkspaceId: 'workspace-member-two',
    });
    expect(workspaceMemberFindManyMock).toHaveBeenCalledWith({
      where: { userId: user.id, status: 'active' },
      select: { workspaceId: true },
    });
    expect(workspaceFindManyMock).toHaveBeenCalledWith({
      where: {
        OR: [
          { ownerUserId: user.id },
          {
            id: {
              in: ['workspace-owned-and-member', 'workspace-member-two', 'workspace-orphan'],
            },
          },
        ],
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true },
    });
    const returnedIds = responseBody.workspaces.map((workspace) => workspace.id);
    expect(returnedIds).not.toContain('workspace-invited');
    expect(returnedIds).not.toContain('workspace-orphan');
    expect(returnedIds).not.toContain('workspace-inaccessible');
    expect(returnedIds.filter((id) => id === 'workspace-owned-and-member')).toHaveLength(1);
  });

  it('returns 401 for anonymous callers without querying workspaces', async () => {
    requireAuthMock.mockRejectedValue(Response.json({ error: 'Unauthorized' }, { status: 401 }));

    const response = await GET(new Request('http://localhost/api/workspaces'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(workspaceMemberFindManyMock).not.toHaveBeenCalled();
    expect(workspaceFindManyMock).not.toHaveBeenCalled();
    expect(resolveActiveWorkspaceIdMock).not.toHaveBeenCalled();
  });

  it('returns 500 when a workspace query fails', async () => {
    workspaceMemberFindManyMock.mockRejectedValue(new Error('database unavailable'));

    const response = await GET(new Request('http://localhost/api/workspaces'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Internal Server Error' });
  });
});
