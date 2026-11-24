// @vitest-environment node
// Unit tests for GET /api/alerts/trend — workspace-gated latest signal.
// Mirrors tests/unit/api/alerts-route.test.ts setup posture — vi.mock
// `server-only`, `@/lib/db`, `@/lib/team-auth`.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const vulnerabilityTrendFindFirst = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    vulnerabilityTrend: { findFirst: vulnerabilityTrendFindFirst },
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
  team: { id: 'team-1', name: 'system' },
});

vi.mock('@/lib/team-auth', () => ({
  requireTeamRole: requireTeamRoleMock,
}));

function makeTrendRow(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: 'team-1',
    windowStart: new Date('2026-02-13T00:00:00Z'),
    windowEnd: new Date('2026-03-15T00:00:00Z'),
    signal: {
      velocity: 4,
      acceleratingDeclines: ['CVE-2025-9999'],
      hotspots: [{ host: 'a.example', port: 443, count: 3 }],
    },
    computedAt: new Date('2026-03-15T06:00:00Z'),
    ...overrides,
  };
}

function makeRequest(url: string) {
  return new Request(url, { method: 'GET', headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  vi.resetModules();
  vulnerabilityTrendFindFirst.mockReset();
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
    team: { id: 'team-1', name: 'system' },
  });
});

describe('GET /api/alerts/trend', () => {
  it('returns 200 with parsed AlertTrendLatest when the latest row exists', async () => {
    vulnerabilityTrendFindFirst.mockResolvedValueOnce(makeTrendRow());

    const { GET } = await import('@/app/api/alerts/trend/route');
    const res = await GET(makeRequest('http://test/api/alerts/trend'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspaceId).toBe('team-1');
    expect(body.windowStart).toBe('2026-02-13T00:00:00.000Z');
    expect(body.windowEnd).toBe('2026-03-15T00:00:00.000Z');
    expect(body.signal.velocity).toBe(4);
    expect(body.signal.acceleratingDeclines).toEqual(['CVE-2025-9999']);
    expect(body.signal.hotspots).toEqual([{ host: 'a.example', port: 443, count: 3 }]);
    expect(body.computedAt).toBe('2026-03-15T06:00:00.000Z');
  });

  it('always seeds the prisma where with the caller teamId (cross-team protection)', async () => {
    vulnerabilityTrendFindFirst.mockResolvedValueOnce(null);

    const { GET } = await import('@/app/api/alerts/trend/route');
    const res = await GET(makeRequest('http://test/api/alerts/trend?workspaceId=team-99'));
    // 404 because no row, but the where should still pin team-1.
    expect(res.status).toBe(404);
    expect(vulnerabilityTrendFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: 'team-1' },
      }),
    );
  });

  it("returns 404 when no latest row exists for the caller's workspace", async () => {
    vulnerabilityTrendFindFirst.mockResolvedValueOnce(null);

    const { GET } = await import('@/app/api/alerts/trend/route');
    const res = await GET(makeRequest('http://test/api/alerts/trend'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not_found');
  });

  it('returns 403 when the user is below member role', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Forbidden' }, { status: 403 });
    });
    const { GET } = await import('@/app/api/alerts/trend/route');
    const res = await GET(makeRequest('http://test/api/alerts/trend'));
    expect(res.status).toBe(403);
  });

  it('returns 401 when there is no session', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Unauthorized' }, { status: 401 });
    });
    const { GET } = await import('@/app/api/alerts/trend/route');
    const res = await GET(makeRequest('http://test/api/alerts/trend'));
    expect(res.status).toBe(401);
  });

  it('returns 500 on malformed signal data', async () => {
    // Hotspots missing required fields — zod parse will reject.
    vulnerabilityTrendFindFirst.mockResolvedValueOnce(
      makeTrendRow({
        signal: { velocity: 4, acceleratingDeclines: [], hotspots: [{ host: 'bad' }] },
      }),
    );

    const { GET } = await import('@/app/api/alerts/trend/route');
    const res = await GET(makeRequest('http://test/api/alerts/trend'));
    expect(res.status).toBe(500);
  });

  it.each([['POST'], ['PUT'], ['PATCH'], ['DELETE']])(
    '%s returns 405 with Allow: GET',
    async (method) => {
      const routeModule = await import('@/app/api/alerts/trend/route');
      const handler = (routeModule as unknown as Record<string, () => Promise<Response>>)[method];
      const res = await handler();
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('GET');
    },
  );
});
