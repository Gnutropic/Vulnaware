// @vitest-environment node
// Unit tests for GET /api/v1/audit-events and the audit() helper.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const auditEventFindMany = vi.fn();
const auditEventCount = vi.fn();
const auditEventCreate = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    auditEvent: {
      findMany: auditEventFindMany,
      count: auditEventCount,
      create: auditEventCreate,
    },
  },
}));

const ADMIN_CTX = {
  user: {
    id: 'user-1',
    role: 'admin',
    email: 'admin@example.com',
    name: 'Admin',
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  membership: { id: 'mem-1', userId: 'user-1', teamId: 'team-1', role: 'admin' },
  team: { id: 'team-1', name: 'system' },
};

vi.mock('@/lib/team-auth', () => ({
  requireTeamRole: async () => ADMIN_CTX,
}));

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    actorUserId: 'user-1',
    actorTeamId: 'team-1',
    action: 'api_key.create',
    resourceType: 'api_key',
    resourceId: 'key-1',
    metadata: null,
    ipAddress: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeRequest(url: string) {
  return new Request(url, { method: 'GET', headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  vi.resetModules();
  auditEventFindMany.mockReset();
  auditEventCount.mockReset();
  auditEventCreate.mockReset();
});

// ===================== GET /api/v1/audit-events =====================

describe('GET /api/v1/audit-events', () => {
  it('returns paginated items for an admin', async () => {
    auditEventFindMany.mockResolvedValueOnce([makeEvent()]);
    auditEventCount.mockResolvedValueOnce(1);

    const { GET } = await import('@/app/api/v1/audit-events/route');
    const res = await GET(makeRequest('http://test/api/v1/audit-events'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(50);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('evt-1');
    expect(body.items[0].action).toBe('api_key.create');
  });

  it('passes filters through to prisma', async () => {
    auditEventFindMany.mockResolvedValueOnce([]);
    auditEventCount.mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/v1/audit-events/route');
    const url =
      'http://test/api/v1/audit-events?actor=u1&action=api_key.create&resourceType=api_key&from=2026-01-01T00%3A00%3A00Z&to=2026-12-31T23%3A59%3A59Z';
    const res = await GET(makeRequest(url));
    expect(res.status).toBe(200);
    expect(auditEventFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          actorTeamId: 'team-1',
          actorUserId: 'u1',
          action: 'api_key.create',
          resourceType: 'api_key',
          createdAt: expect.objectContaining({
            gte: expect.any(Date),
            lte: expect.any(Date),
          }),
        }),
      }),
    );
  });

  it('returns 403 when the user is not admin', async () => {
    vi.doMock('@/lib/team-auth', () => ({
      requireTeamRole: async () => {
        throw Response.json({ error: 'Forbidden' }, { status: 403 });
      },
    }));
    const { GET } = await import('@/app/api/v1/audit-events/route');
    const res = await GET(makeRequest('http://test/api/v1/audit-events'));
    expect(res.status).toBe(403);
  });

  it('returns 400 on invalid query params (pageSize over max)', async () => {
    const { GET } = await import('@/app/api/v1/audit-events/route');
    const res = await GET(makeRequest('http://test/api/v1/audit-events?pageSize=999'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('bad_request');
  });

  it('returns 500 on DB error', async () => {
    auditEventFindMany.mockRejectedValueOnce(new Error('db down'));
    auditEventCount.mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/v1/audit-events/route');
    const res = await GET(makeRequest('http://test/api/v1/audit-events'));
    expect(res.status).toBe(500);
  });
});

// ===================== audit() helper =====================

describe('audit helper', () => {
  it('writes an event with the correct shape', async () => {
    auditEventCreate.mockResolvedValueOnce({});
    const { audit } = await import('@/lib/business/audit');

    await audit({
      actorUserId: 'user-1',
      actorTeamId: 'team-1',
      action: 'api_key.create',
      resourceType: 'api_key',
      resourceId: 'key-1',
      metadata: { name: 'prod' },
      ipAddress: '1.2.3.4',
    });

    expect(auditEventCreate).toHaveBeenCalledWith({
      data: {
        actorUserId: 'user-1',
        actorTeamId: 'team-1',
        action: 'api_key.create',
        resourceType: 'api_key',
        resourceId: 'key-1',
        metadata: { name: 'prod' },
        ipAddress: '1.2.3.4',
      },
    });
  });

  it('omits metadata when not provided', async () => {
    auditEventCreate.mockResolvedValueOnce({});
    const { audit } = await import('@/lib/business/audit');

    await audit({
      actorUserId: 'user-1',
      actorTeamId: 'team-1',
      action: 'membership.remove',
      resourceType: 'membership',
      resourceId: 'mem-1',
      ipAddress: null,
    });

    expect(auditEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: undefined,
        ipAddress: null,
      }),
    });
  });
});
