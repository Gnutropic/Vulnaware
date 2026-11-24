// @vitest-environment node
// @polsia:user-owned — Dashboard active-workspace and roster-context coverage.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveDashboardWorkspaceContext } from '@/lib/business/dashboard-workspace-context';

const { cookiesMock, workspaceFindFirst, workspaceFindUnique, workspaceMemberFindFirst } = vi.hoisted(
  () => ({
    cookiesMock: vi.fn(),
    workspaceFindFirst: vi.fn(),
    workspaceFindUnique: vi.fn(),
    workspaceMemberFindFirst: vi.fn(),
  }),
);

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: cookiesMock }));
vi.mock('@/lib/db', () => ({
  prisma: {
    workspace: { findFirst: workspaceFindFirst, findUnique: workspaceFindUnique },
    workspaceMember: { findFirst: workspaceMemberFindFirst },
  },
}));

describe('resolveDashboardWorkspaceContext', () => {
  let cookieValue: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    cookieValue = undefined;
    cookiesMock.mockImplementation(async () => ({
      get: () => (cookieValue ? { value: cookieValue } : undefined),
    }));
    workspaceFindFirst.mockResolvedValue(null);
    workspaceFindUnique.mockResolvedValue(null);
    workspaceMemberFindFirst.mockResolvedValue(null);
  });

  it('returns the selected owned workspace and its active roster row', async () => {
    cookieValue = 'owned-workspace';
    workspaceFindFirst.mockImplementation(async ({ where }: { where: Record<string, string> }) =>
      where.id === 'owned-workspace' && where.ownerUserId === 'user-1'
        ? { id: 'owned-workspace' }
        : null,
    );
    workspaceMemberFindFirst.mockResolvedValueOnce({ id: 'owned-roster-row' });

    await expect(resolveDashboardWorkspaceContext('user-1')).resolves.toEqual({
      workspaceId: 'owned-workspace',
      workspaceMemberId: 'owned-roster-row',
    });
    expect(workspaceMemberFindFirst).toHaveBeenCalledWith({
      where: { workspaceId: 'owned-workspace', userId: 'user-1', status: 'active' },
      select: { id: true },
    });
  });

  it('returns a selected workspace with the caller active member row', async () => {
    cookieValue = 'member-workspace';
    workspaceFindUnique.mockResolvedValue({ id: 'member-workspace' });
    workspaceMemberFindFirst.mockResolvedValue({ id: 'member-roster-row' });

    await expect(resolveDashboardWorkspaceContext('user-1')).resolves.toEqual({
      workspaceId: 'member-workspace',
      workspaceMemberId: 'member-roster-row',
    });
    expect(workspaceMemberFindFirst).toHaveBeenCalledWith({
      where: { workspaceId: 'member-workspace', userId: 'user-1', status: 'active' },
      select: { id: true },
    });
  });

  it('falls back to an owned workspace when the selection is stale or inaccessible', async () => {
    cookieValue = 'inaccessible-workspace';
    workspaceFindFirst.mockImplementation(async ({ where }: { where: Record<string, string> }) =>
      where.ownerUserId === 'user-1' && !where.id ? { id: 'fallback-workspace' } : null,
    );
    workspaceFindUnique.mockResolvedValue({ id: 'inaccessible-workspace' });
    workspaceMemberFindFirst.mockImplementation(
      async ({ where }: { where: { workspaceId: string; status: string } }) =>
        where.workspaceId === 'fallback-workspace' && where.status === 'active'
          ? { id: 'fallback-roster-row' }
          : null,
    );

    await expect(resolveDashboardWorkspaceContext('user-1')).resolves.toEqual({
      workspaceId: 'fallback-workspace',
      workspaceMemberId: 'fallback-roster-row',
    });
    expect(workspaceMemberFindFirst).toHaveBeenCalledTimes(2);
  });

  it('returns null when no owned, selected, or accessible workspace exists', async () => {
    cookieValue = 'inaccessible-workspace';
    workspaceFindUnique.mockResolvedValue({ id: 'inaccessible-workspace' });

    await expect(resolveDashboardWorkspaceContext('user-1')).resolves.toBeNull();
    expect(workspaceMemberFindFirst).toHaveBeenCalledTimes(1);
  });

  it('keeps the workspace context when an owned workspace has no active roster row', async () => {
    cookieValue = 'owned-workspace-without-roster';
    workspaceFindFirst.mockResolvedValue({ id: 'owned-workspace-without-roster' });

    await expect(resolveDashboardWorkspaceContext('user-1')).resolves.toEqual({
      workspaceId: 'owned-workspace-without-roster',
      workspaceMemberId: null,
    });
  });
});
