// @vitest-environment node
// Unit tests for GET /api/alerts/[id]/activity. Posture mirrors
// tests/unit/api/alerts-reopen-route.test.ts:
//   - vi.mock('server-only') so the module loads
//   - vi.mock('@/lib/db') exposing the prisma.alert.findFirst +
//     prisma.user.findMany surface the route touches
//   - vi.mock('@/lib/team-auth') with a swappable requireTeamRole
//
// Coverage:
//   - 401 anon, 403 below-member — opaque, body untouched
//   - 404 cross-team and missing
//   - 200 one reopen event with id:'reopen', ISO date, actor resolved
//     via batched User.findMany, reason echoed
//   - 200 zero events (never-reopened row)
//   - GET/PUT/PATCH/DELETE → 405 with Allow: GET

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const alertFindFirst = vi.fn();
const userFindMany = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    alert: {
      findFirst: alertFindFirst,
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
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  },
  membership: { id: 'mem-1', userId: 'user-1', teamId: 'team-1', role: 'member' },
  team: { id: 'team-1', name: 'workspace' },
});

vi.mock('@/lib/team-auth', () => ({
  requireTeamRole: async () => requireTeamRoleMock(),
}));

const REOPEN_AT = new Date('2026-07-02T09:00:00Z');

function makeGetRequest(id = 'alert-1') {
  return new Request(`http://test/api/alerts/${id}/activity`);
}

function makeReopenedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-1',
    reopenedAt: REOPEN_AT,
    reopenedBy: 'user-1',
    reopenReason: 'patched but reconfirmed',
    ...overrides,
  };
}

function makeNeverReopenedRow() {
  return {
    id: 'alert-1',
    reopenedAt: null,
    reopenedBy: null,
    reopenReason: null,
  };
}

beforeEach(() => {
  vi.resetModules();
  alertFindFirst.mockReset();
  userFindMany.mockReset();
  requireTeamRoleMock.mockReset();
  requireTeamRoleMock.mockResolvedValue({
    user: {
      id: 'user-1',
      role: 'member',
      email: 'member@example.com',
      name: 'Member',
      emailVerified: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    },
    membership: { id: 'mem-1', userId: 'user-1', teamId: 'team-1', role: 'member' },
    team: { id: 'team-1', name: 'workspace' },
  });
});

describe('GET /api/alerts/[id]/activity', () => {
  it('returns 401 when there is no session', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Unauthorized' }, { status: 401 });
    });
    const { GET } = await import('@/app/api/alerts/[id]/activity/route');
    const res = await GET(makeGetRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(401);
    expect(alertFindFirst).not.toHaveBeenCalled();
  });

  it('returns 403 when caller is below member', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Forbidden' }, { status: 403 });
    });
    const { GET } = await import('@/app/api/alerts/[id]/activity/route');
    const res = await GET(makeGetRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(403);
    expect(alertFindFirst).not.toHaveBeenCalled();
  });

  it('returns opaque 404 cross-team', async () => {
    alertFindFirst.mockResolvedValueOnce(null);
    const { GET } = await import('@/app/api/alerts/[id]/activity/route');
    const res = await GET(makeGetRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'not_found' });
    expect(userFindMany).not.toHaveBeenCalled();
  });

  it('returns 200 + single reopen event for a never-reopened row (zero events)', async () => {
    // A row that has never been reopened carries `reopenedAt: null`
    // and stamps no activity — the activity endpoint short-circuits
    // to an empty list without an extra User.findMany read.
    alertFindFirst.mockResolvedValueOnce(makeNeverReopenedRow());
    const { GET } = await import('@/app/api/alerts/[id]/activity/route');
    const res = await GET(makeGetRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ items: [], nextCursor: null });
    // No User lookup — empty timeline skips the actor-name resolution.
    expect(userFindMany).not.toHaveBeenCalled();
  });

  it('returns 200 + single reopen event with actor name + reason', async () => {
    alertFindFirst.mockResolvedValueOnce(makeReopenedRow());
    userFindMany.mockResolvedValueOnce([{ id: 'user-1', name: 'Operator One' }]);
    const { GET } = await import('@/app/api/alerts/[id]/activity/route');
    const res = await GET(makeGetRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toEqual({
      id: 'reopen',
      at: REOPEN_AT.toISOString(),
      actorId: 'user-1',
      actorName: 'Operator One',
      reason: 'patched but reconfirmed',
    });
    expect(body.nextCursor).toBeNull();
  });

  it('returns actorName: null when the User row is gone (best-effort resolution)', async () => {
    // Soft-delete edge case — the reopen trio fires on a now-deleted
    // User. The activity feed doesn't throw; it surfaces a null
    // actorName so the UI de-renders to "Unknown actor" without
    // a 500.
    alertFindFirst.mockResolvedValueOnce(makeReopenedRow());
    userFindMany.mockResolvedValueOnce([]);
    const { GET } = await import('@/app/api/alerts/[id]/activity/route');
    const res = await GET(makeGetRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0].actorId).toBe('user-1');
    expect(body.items[0].actorName).toBeNull();
  });

  it('returns 500 on DB throw', async () => {
    alertFindFirst.mockRejectedValueOnce(new Error('db down'));
    const { GET } = await import('@/app/api/alerts/[id]/activity/route');
    const res = await GET(makeGetRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(500);
  });
});

describe('methodNotAllowed stubs for /api/alerts/[id]/activity', () => {
  it.each([['POST'], ['PUT'], ['PATCH'], ['DELETE']])(
    '%s returns 405 with Allow: GET',
    async (method) => {
      const routeModule = await import('@/app/api/alerts/[id]/activity/route');
      const handler = (routeModule as unknown as Record<string, () => Promise<Response>>)[method];
      const res = await handler();
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('GET');
    },
  );
});
