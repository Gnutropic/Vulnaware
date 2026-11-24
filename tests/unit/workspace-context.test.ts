// @vitest-environment node
// @polsia:user-owned — Active workspace selection and membership validation coverage.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveActiveWorkspaceIdForSelection,
  type WorkspaceContextClient,
} from '@/lib/business/active-workspace';

const { workspaceFindFirst, workspaceFindUnique, workspaceMemberFindFirst } = vi.hoisted(() => ({
  workspaceFindFirst: vi.fn(),
  workspaceFindUnique: vi.fn(),
  workspaceMemberFindFirst: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({
  prisma: {
    workspace: { findFirst: workspaceFindFirst, findUnique: workspaceFindUnique },
    workspaceMember: { findFirst: workspaceMemberFindFirst },
  },
}));

const client = {
  workspace: { findFirst: workspaceFindFirst, findUnique: workspaceFindUnique },
  workspaceMember: { findFirst: workspaceMemberFindFirst },
} as unknown as WorkspaceContextClient;

describe('active workspace selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceFindFirst.mockResolvedValue(null);
    workspaceFindUnique.mockResolvedValue(null);
    workspaceMemberFindFirst.mockResolvedValue(null);
  });

  it('accepts a selected workspace owned by the user', async () => {
    workspaceFindFirst.mockResolvedValueOnce({ id: 'owned-selected' });

    await expect(
      resolveActiveWorkspaceIdForSelection('user-1', 'owned-selected', client),
    ).resolves.toBe('owned-selected');
    expect(workspaceFindFirst).toHaveBeenCalledWith({
      where: { id: 'owned-selected', ownerUserId: 'user-1' },
      select: { id: true },
    });
    expect(workspaceFindUnique).not.toHaveBeenCalled();
  });

  it('accepts a selected workspace with an active membership', async () => {
    workspaceFindUnique.mockResolvedValueOnce({ id: 'shared-workspace' });
    workspaceMemberFindFirst.mockResolvedValueOnce({ id: 'active-row' });

    await expect(
      resolveActiveWorkspaceIdForSelection('user-1', 'shared-workspace', client),
    ).resolves.toBe('shared-workspace');
    expect(workspaceMemberFindFirst).toHaveBeenCalledWith({
      where: { workspaceId: 'shared-workspace', userId: 'user-1', status: 'active' },
      select: { id: true },
    });
    expect(workspaceFindFirst).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['stale cookie', 'deleted-workspace'],
    ['malformed cookie', 'x'.repeat(192)],
    ['inaccessible workspace', 'other-workspace'],
    ['invited-only membership', 'invited-workspace'],
  ])('falls back to the oldest owned workspace for a %s', async (_label, cookieValue) => {
    workspaceFindFirst.mockImplementation(
      async (args: { where: { id?: string; ownerUserId?: string } }) =>
        args.where.ownerUserId === 'user-1' && !args.where.id ? { id: 'oldest-owned' } : null,
    );
    workspaceFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'deleted-workspace' ? null : { id: where.id },
    );

    await expect(
      resolveActiveWorkspaceIdForSelection('user-1', cookieValue, client),
    ).resolves.toBe('oldest-owned');
    expect(workspaceFindFirst).toHaveBeenLastCalledWith({
      where: { ownerUserId: 'user-1' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
  });

  it('returns no workspace when the user has no valid selection or owned workspace', async () => {
    await expect(
      resolveActiveWorkspaceIdForSelection('user-1', null, client),
    ).resolves.toBeNull();
    expect(workspaceFindFirst).toHaveBeenCalledWith({
      where: { ownerUserId: 'user-1' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
  });
});
