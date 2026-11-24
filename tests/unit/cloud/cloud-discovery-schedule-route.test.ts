// @vitest-environment node
// Unit tests for /api/v1/cloud/discovery/schedule**. Mocks prisma,
// require-auth, and the audit business lib so we can pin down the admin
// gate + the auth/CRUD contract without booting prisma / better-auth.

import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const membershipFindUnique = vi.fn();
const scheduleCreate = vi.fn();
const scheduleDeleteMany = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    membership: { findUnique: membershipFindUnique },
    cloudDiscoverySchedule: {
      create: scheduleCreate,
      deleteMany: scheduleDeleteMany,
    },
  },
}));

const MEMBERSHIP_TEAM_ID = 'team-system-id';
const SESSION_USER = {
  id: 'user-admin-1',
  email: 'admin@example.com',
  name: 'Admin',
  role: 'admin',
  emailVerified: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

// Mutable behavior the require-auth mock consults each call so we can
// flip roles mid-suite without doMock's sticky reorder headaches.
let requireAuthImpl: () => Promise<typeof SESSION_USER> = async () => SESSION_USER;

vi.mock('@/lib/require-auth', () => ({
  requireAuth: async () => requireAuthImpl(),
}));

const auditMock = vi.fn();
vi.mock('@/lib/business/audit', () => ({
  audit: (...args: unknown[]) => auditMock(...args),
  extractIp: () => null,
}));

function authedRequest(
  method: 'POST' | 'DELETE',
  path = '/api/v1/cloud/discovery/schedule',
  body?: unknown,
) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://test${path}`, init);
}

function adminMembership() {
  return { id: 'mem-1', userId: SESSION_USER.id, teamId: MEMBERSHIP_TEAM_ID };
}

function createdRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sched-1',
    teamId: MEMBERSHIP_TEAM_ID,
    provider: 'aws',
    cadenceMinutes: 120,
    lastRunAt: null,
    nextRunAt: new Date('2026-07-22T12:00:00Z'),
    createdById: SESSION_USER.id,
    createdAt: new Date('2026-07-22T11:59:00Z'),
    ...overrides,
  };
}

function setAuthAsAdmin() {
  requireAuthImpl = async () => SESSION_USER;
}

function setAuthAsNonAdmin() {
  requireAuthImpl = async () => ({ ...SESSION_USER, role: 'user' });
}

function setAuthAnonymous() {
  requireAuthImpl = async () => {
    throw NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  };
}

beforeEach(() => {
  vi.resetModules();
  membershipFindUnique.mockReset();
  scheduleCreate.mockReset();
  scheduleDeleteMany.mockReset();
  auditMock.mockReset();
  membershipFindUnique.mockResolvedValue(adminMembership());
  setAuthAsAdmin();
});

// ===================== POST /api/v1/cloud/discovery/schedule =====================

describe('POST /api/v1/cloud/discovery/schedule', () => {
  it("creates a schedule row tied to the admin's team and returns 201", async () => {
    scheduleCreate.mockResolvedValueOnce(createdRow());
    const { POST } = await import('@/app/api/v1/cloud/discovery/schedule/route');
    const res = await POST(
      authedRequest('POST', '/api/v1/cloud/discovery/schedule', {
        provider: 'aws',
        cadenceMinutes: 120,
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe('sched-1');
    expect(body.teamId).toBe(MEMBERSHIP_TEAM_ID);
    expect(body.provider).toBe('aws');
    expect(body.cadenceMinutes).toBe(120);
    expect(body.lastRunAt).toBeNull();

    expect(scheduleCreate).toHaveBeenCalledTimes(1);
    const createArg = scheduleCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(createArg.data.teamId).toBe(MEMBERSHIP_TEAM_ID);
    expect(createArg.data.provider).toBe('aws');
    expect(createArg.data.cadenceMinutes).toBe(120);
    expect(createArg.data.createdById).toBe('user-admin-1');
    expect(createArg.data.nextRunAt).toBeInstanceOf(Date);
  });

  it('returns 401 when there is no session', async () => {
    setAuthAnonymous();
    const { POST } = await import('@/app/api/v1/cloud/discovery/schedule/route');
    const res = await POST(
      authedRequest('POST', '/api/v1/cloud/discovery/schedule', {
        provider: 'aws',
        cadenceMinutes: 60,
      }),
    );
    expect(res.status).toBe(401);
    expect(scheduleCreate).not.toHaveBeenCalled();
  });

  it('returns 403 for non-admin session users', async () => {
    setAuthAsNonAdmin();
    const { POST } = await import('@/app/api/v1/cloud/discovery/schedule/route');
    const res = await POST(
      authedRequest('POST', '/api/v1/cloud/discovery/schedule', {
        provider: 'aws',
        cadenceMinutes: 60,
      }),
    );
    expect(res.status).toBe(403);
    expect(scheduleCreate).not.toHaveBeenCalled();
  });

  it('returns 404 when the admin has no team', async () => {
    membershipFindUnique.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/v1/cloud/discovery/schedule/route');
    const res = await POST(
      authedRequest('POST', '/api/v1/cloud/discovery/schedule', {
        provider: 'aws',
        cadenceMinutes: 60,
      }),
    );
    expect(res.status).toBe(404);
    expect(scheduleCreate).not.toHaveBeenCalled();
  });

  it('returns 400 when cadenceMinutes is below the 60-minute floor', async () => {
    const { POST } = await import('@/app/api/v1/cloud/discovery/schedule/route');
    const res = await POST(
      authedRequest('POST', '/api/v1/cloud/discovery/schedule', {
        provider: 'aws',
        cadenceMinutes: 30,
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors?.cadenceMinutes).toBeTruthy();
    expect(scheduleCreate).not.toHaveBeenCalled();
  });

  it('returns 400 when the provider is unknown', async () => {
    const { POST } = await import('@/app/api/v1/cloud/discovery/schedule/route');
    const res = await POST(
      authedRequest('POST', '/api/v1/cloud/discovery/schedule', {
        provider: 'gcloud',
        cadenceMinutes: 120,
      }),
    );
    expect(res.status).toBe(400);
    expect(scheduleCreate).not.toHaveBeenCalled();
  });

  it('records a create audit entry on success', async () => {
    scheduleCreate.mockResolvedValueOnce(createdRow({ provider: 'azure', cadenceMinutes: 240 }));
    const { POST } = await import('@/app/api/v1/cloud/discovery/schedule/route');
    await POST(
      authedRequest('POST', '/api/v1/cloud/discovery/schedule', {
        provider: 'azure',
        cadenceMinutes: 240,
      }),
    );
    expect(auditMock).toHaveBeenCalledOnce();
    const call = auditMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.action).toBe('cloud_discovery_schedule.create');
    expect(call.actorTeamId).toBe(MEMBERSHIP_TEAM_ID);
    expect(call.resourceType).toBe('cloud_discovery_schedule');
    expect(call.resourceId).toBe('sched-1');
    expect(call.metadata).toEqual({ provider: 'azure', cadenceMinutes: 240 });
  });
});

// ===================== DELETE /api/v1/cloud/discovery/schedule/[id] =====================

describe('DELETE /api/v1/cloud/discovery/schedule/[id]', () => {
  it('returns 204 for an own-team id', async () => {
    scheduleDeleteMany.mockResolvedValueOnce({ count: 1 });
    const { DELETE } = await import('@/app/api/v1/cloud/discovery/schedule/[id]/route');
    const res = await DELETE(authedRequest('DELETE', '/api/v1/cloud/discovery/schedule/sched-1'), {
      params: Promise.resolve({ id: 'sched-1' }),
    });
    expect(res.status).toBe(204);
    expect(scheduleDeleteMany).toHaveBeenCalledWith({
      where: { id: 'sched-1', teamId: MEMBERSHIP_TEAM_ID },
    });
    expect(auditMock).toHaveBeenCalledOnce();
    expect((auditMock.mock.calls[0]?.[0] as Record<string, unknown>).action).toBe(
      'cloud_discovery_schedule.delete',
    );
  });

  it('returns 404 for a foreign-team id (deleteMany reports count 0)', async () => {
    scheduleDeleteMany.mockResolvedValueOnce({ count: 0 });
    const { DELETE } = await import('@/app/api/v1/cloud/discovery/schedule/[id]/route');
    const res = await DELETE(authedRequest('DELETE', '/api/v1/cloud/discovery/schedule/foreign'), {
      params: Promise.resolve({ id: 'foreign' }),
    });
    expect(res.status).toBe(404);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('returns 403 for non-admin session users', async () => {
    setAuthAsNonAdmin();
    const { DELETE } = await import('@/app/api/v1/cloud/discovery/schedule/[id]/route');
    const res = await DELETE(authedRequest('DELETE', '/api/v1/cloud/discovery/schedule/sched-1'), {
      params: Promise.resolve({ id: 'sched-1' }),
    });
    expect(res.status).toBe(403);
    expect(scheduleDeleteMany).not.toHaveBeenCalled();
  });

  it('returns 401 when there is no session', async () => {
    setAuthAnonymous();
    const { DELETE } = await import('@/app/api/v1/cloud/discovery/schedule/[id]/route');
    const res = await DELETE(authedRequest('DELETE', '/api/v1/cloud/discovery/schedule/sched-1'), {
      params: Promise.resolve({ id: 'sched-1' }),
    });
    expect(res.status).toBe(401);
  });
});
