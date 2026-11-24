// @vitest-environment node
// Unit tests for GET /api/team/members. The picker only needs the active
// roster (no invites), with id + display label + email. Verifies:
//   - 401 / 403 gates
//   - `status='active'` is mandatory (no invited rows leak behind the
//     picker's "this colleague isn't onboarded yet" 400)
//   - name falls back to WorkspaceMember.email when User.name is missing
//   - skips the User lookup entirely when no rows have a userId (rare but
//     possible if the bootstrap hasn't run)
//   - 405 for everything but GET

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const workspaceMemberFindMany = vi.fn();
const userFindMany = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    workspaceMember: {
      findMany: workspaceMemberFindMany,
    },
    user: {
      findMany: userFindMany,
    },
  },
}));

const requireTeamRoleMock = vi.fn();
requireTeamRoleMock.mockResolvedValue({
  user: {
    id: 'user-1',
    role: 'member',
    email: 'member@example.com',
    name: 'Member',
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  membership: { id: 'mem-1', userId: 'user-1', teamId: 'team-1', role: 'member' },
  team: { id: 'team-1', name: 'workspace' },
});

vi.mock('@/lib/team-auth', () => ({
  requireTeamRole: requireTeamRoleMock,
}));

function makeRequest() {
  return new Request('http://test/api/team/members', { method: 'GET' });
}

beforeEach(() => {
  vi.resetModules();
  workspaceMemberFindMany.mockReset();
  userFindMany.mockReset();
  requireTeamRoleMock.mockReset();
  requireTeamRoleMock.mockResolvedValue({
    user: {
      id: 'user-1',
      role: 'member',
      email: 'member@example.com',
      name: 'Member',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    membership: { id: 'mem-1', userId: 'user-1', teamId: 'team-1', role: 'member' },
    team: { id: 'team-1', name: 'workspace' },
  });
});

describe('GET /api/team/members', () => {
  it('returns the active roster only — never invited rows', async () => {
    workspaceMemberFindMany.mockResolvedValueOnce([
      { id: 'wm-2', userId: 'user-2', email: 'alice@example.com' },
      { id: 'wm-3', userId: 'user-3', email: 'bob@example.com' },
    ]);
    userFindMany.mockResolvedValueOnce([
      { id: 'user-2', email: 'alice@example.com', name: 'Alice' },
      { id: 'user-3', email: 'bob@example.com', name: 'Bob' },
    ]);
    const { GET } = await import('@/app/api/team/members/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    // Status='active' is enforced as part of the where clause — this calls
    // an explicit `status: 'active'` guard even though the underlying
    // filter doesn't soft-delete.
    expect(workspaceMemberFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'active', workspaceId: 'team-1' }),
      }),
    );
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toEqual({ id: 'wm-2', name: 'Alice', email: 'alice@example.com' });
    expect(body.items[1]).toEqual({ id: 'wm-3', name: 'Bob', email: 'bob@example.com' });
  });

  it('falls back to WorkspaceMember.email when User.name is null', async () => {
    workspaceMemberFindMany.mockResolvedValueOnce([
      { id: 'wm-2', userId: 'user-2', email: 'alice@example.com' },
    ]);
    userFindMany.mockResolvedValueOnce([{ id: 'user-2', email: 'alice@example.com', name: null }]);
    const { GET } = await import('@/app/api/team/members/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0]).toEqual({
      id: 'wm-2',
      name: 'alice@example.com',
      email: 'alice@example.com',
    });
  });

  it('handles a row with null userId (rare bootstrap window) — falls back to email', async () => {
    workspaceMemberFindMany.mockResolvedValueOnce([
      { id: 'wm-2', userId: null, email: 'pending@example.com' },
    ]);
    const { GET } = await import('@/app/api/team/members/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(userFindMany).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.items[0]).toEqual({
      id: 'wm-2',
      name: 'pending@example.com',
      email: 'pending@example.com',
    });
  });

  it('returns 401 when there is no session', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Unauthorized' }, { status: 401 });
    });
    const { GET } = await import('@/app/api/team/members/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns 403 when caller is below member', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Forbidden' }, { status: 403 });
    });
    const { GET } = await import('@/app/api/team/members/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
  });

  it('returns 500 on DB error', async () => {
    workspaceMemberFindMany.mockRejectedValueOnce(new Error('db down'));
    const { GET } = await import('@/app/api/team/members/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
  });

  it.each([['POST'], ['PUT'], ['PATCH'], ['DELETE']])(
    '%s returns 405 with Allow: GET',
    async (method) => {
      const routeModule = await import('@/app/api/team/members/route');
      const handler = (routeModule as unknown as Record<string, () => Promise<Response>>)[method];
      const res = await handler();
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('GET');
    },
  );
});
