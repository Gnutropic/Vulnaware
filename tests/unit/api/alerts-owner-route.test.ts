// @vitest-environment node
// Unit tests for PATCH /api/alerts/[id]/owner. Mirrors
// tests/unit/api/alerts-route.test.ts setup posture — vi.mock the
// shared @/lib/db + @/lib/team-auth surface, then exercise:
//   - 401 / 403 auth gates (requireTeamRole throws an opaque Response)
//   - opaque 404 when the alert is from a different team
//   - 400 with `{ errors: { ownerId } }` when the picked member is from
//     another team (or non-active) — proves the cross-team guard fires
//     BEFORE the write
//   - null body → row updated to null, ownerId/ownerName both null in
//     the response
//   - valid member id → row updated, response resolves ownerName from
//     the chain WorkspaceMember → User.name

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const alertFindFirst = vi.fn();
const alertFindUnique = vi.fn();
const alertUpdate = vi.fn();
const workspaceMemberFindFirst = vi.fn();
const workspaceMemberFindMany = vi.fn();
const userFindUnique = vi.fn();
const userFindMany = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    alert: {
      findFirst: alertFindFirst,
      findUnique: alertFindUnique,
      update: alertUpdate,
    },
    workspaceMember: {
      findFirst: workspaceMemberFindFirst,
      findMany: workspaceMemberFindMany,
    },
    user: {
      findUnique: userFindUnique,
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

function makeRequest(body: unknown, id = 'alert-1') {
  return new Request(`http://test/api/alerts/${id}/owner`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

function makeAlertRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-1',
    teamId: 'team-1',
    findingId: 'finding-1',
    severity: 'high',
    source: 'kev',
    assigneeId: null,
    ownerId: null,
    status: 'open',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    acknowledgedAt: null,
    finding: {
      cveId: 'CVE-2026-0001',
      asset: { host: 'app.example.com', port: 443, protocol: 'tcp' },
      scan: { source: 'manual' },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  alertFindFirst.mockReset();
  alertFindUnique.mockReset();
  alertUpdate.mockReset();
  workspaceMemberFindFirst.mockReset();
  workspaceMemberFindMany.mockReset();
  userFindUnique.mockReset();
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

describe('PATCH /api/alerts/[id]/owner', () => {
  it('returns 401 when there is no session', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Unauthorized' }, { status: 401 });
    });
    const { PATCH } = await import('@/app/api/alerts/[id]/owner/route');
    const res = await PATCH(makeRequest({ ownerId: 'wm-2' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 when caller is below member', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Forbidden' }, { status: 403 });
    });
    const { PATCH } = await import('@/app/api/alerts/[id]/owner/route');
    const res = await PATCH(makeRequest({ ownerId: 'wm-2' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(403);
  });

  it('returns opaque 404 when the alert belongs to a different team', async () => {
    // findFirst seeded with teamId='team-1' returns null when the row
    // exists but teamId != 'team-1' (caller's team). The re-read belt-and-
    // suspenders guard isn't tripped because we don't get that far.
    alertFindFirst.mockResolvedValueOnce(null);
    const { PATCH } = await import('@/app/api/alerts/[id]/owner/route');
    const res = await PATCH(makeRequest({ ownerId: 'wm-2' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'not_found' });
    // No write should have happened before the 404.
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('returns 400 with field error when ownerId is not an active member of this workspace', async () => {
    alertFindFirst.mockResolvedValueOnce({ id: 'alert-1' });
    workspaceMemberFindFirst.mockResolvedValueOnce(null);
    const { PATCH } = await import('@/app/api/alerts/[id]/owner/route');
    const res = await PATCH(makeRequest({ ownerId: 'wm-foreign' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors?.ownerId).toMatch(/not an active member/i);
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('returns 400 when the body is invalid JSON', async () => {
    alertFindFirst.mockResolvedValueOnce({ id: 'alert-1' });
    const req = new Request('http://test/api/alerts/alert-1/owner', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    const { PATCH } = await import('@/app/api/alerts/[id]/owner/route');
    const res = await PATCH(req, { params: Promise.resolve({ id: 'alert-1' }) });
    expect(res.status).toBe(400);
  });

  it('validates ownerId against the schema', async () => {
    alertFindFirst.mockResolvedValueOnce({ id: 'alert-1' });
    const { PATCH } = await import('@/app/api/alerts/[id]/owner/route');
    const res = await PATCH(makeRequest({ ownerId: 123 }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors).toBeDefined();
  });

  it('clears the owner (ownerId: null) and returns ownerId/ownerName null', async () => {
    alertFindFirst.mockResolvedValueOnce({ id: 'alert-1' });
    alertUpdate.mockResolvedValueOnce({ id: 'alert-1' });
    // After the write, findUnique returns a row whose ownerId was just zeroed
    // out. The picker renders "Unassigned" on null — ownerName lookup is
    // skipped entirely because the FK is null.
    alertFindUnique.mockResolvedValueOnce(makeAlertRow({ ownerId: null }));
    const { PATCH } = await import('@/app/api/alerts/[id]/owner/route');
    const res = await PATCH(makeRequest({ ownerId: null }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    expect(alertUpdate).toHaveBeenCalledWith({
      where: { id: 'alert-1' },
      data: { ownerId: null },
    });
    const body = await res.json();
    expect(body.ownerId).toBeNull();
    expect(body.ownerName).toBeNull();
    // Verify the Active guard was skipped entirely (no member lookup for null)
    expect(workspaceMemberFindFirst).not.toHaveBeenCalled();
  });

  it('sets the owner and resolves ownerName from the WorkspaceMember → User chain', async () => {
    alertFindFirst.mockResolvedValueOnce({ id: 'alert-1' });
    workspaceMemberFindFirst
      // First call: cross-team guard lookup. Returns the active row.
      .mockResolvedValueOnce({ id: 'wm-2' })
      // Second call: re-read for ownerName resolution.
      .mockResolvedValueOnce({ id: 'wm-2', userId: 'user-2', email: 'alice@example.com' });
    userFindUnique.mockResolvedValueOnce({ name: 'Alice' });
    alertUpdate.mockResolvedValueOnce({ id: 'alert-1' });
    alertFindUnique.mockResolvedValueOnce(makeAlertRow({ ownerId: 'wm-2' }));
    const { PATCH } = await import('@/app/api/alerts/[id]/owner/route');
    const res = await PATCH(makeRequest({ ownerId: 'wm-2' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    expect(alertUpdate).toHaveBeenCalledWith({
      where: { id: 'alert-1' },
      data: { ownerId: 'wm-2' },
    });
    const body = await res.json();
    expect(body.ownerId).toBe('wm-2');
    expect(body.ownerName).toBe('Alice');
  });

  it('returns ownerName=null when WorkspaceMember exists but User.name is null', async () => {
    alertFindFirst.mockResolvedValueOnce({ id: 'alert-1' });
    workspaceMemberFindFirst
      .mockResolvedValueOnce({ id: 'wm-2' })
      .mockResolvedValueOnce({ id: 'wm-2', userId: 'user-2', email: 'alice@example.com' });
    userFindUnique.mockResolvedValueOnce({ name: null });
    alertUpdate.mockResolvedValueOnce({ id: 'alert-1' });
    alertFindUnique.mockResolvedValueOnce(makeAlertRow({ ownerId: 'wm-2' }));
    const { PATCH } = await import('@/app/api/alerts/[id]/owner/route');
    const res = await PATCH(makeRequest({ ownerId: 'wm-2' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ownerId).toBe('wm-2');
    expect(body.ownerName).toBeNull();
  });

  it('returns 500 on DB error', async () => {
    alertFindFirst.mockRejectedValueOnce(new Error('db down'));
    const { PATCH } = await import('@/app/api/alerts/[id]/owner/route');
    const res = await PATCH(makeRequest({ ownerId: 'wm-2' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(500);
  });

  it.each([['GET'], ['POST'], ['PUT'], ['DELETE']])(
    '%s returns 405 with Allow: PATCH',
    async (method) => {
      const routeModule = await import('@/app/api/alerts/[id]/owner/route');
      const handler = (routeModule as unknown as Record<string, () => Promise<Response>>)[method];
      const res = await handler();
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('PATCH');
    },
  );
});
