// @vitest-environment node
// Unit tests for POST /api/alerts/assign-owner-batch — the bulk
// "Assign owner…" companion to PATCH /api/alerts/[id]/owner.
// Posture mirrors tests/unit/api/alerts-snooze-batch-route.test.ts
// with adjustments for the deltas that drive the bulk-assign-owner
// gesture:
//
//   - vi.mock('server-only') so the module loads
//   - vi.mock('@/lib/db') exposing the prisma.alert.{findMany,
//     update} surface AND prisma.workspaceMember.findFirst +
//     prisma.user.findUnique (the route's FK-validation + name
//     resolution paths)
//   - vi.mock('@/lib/team-auth') with a swappable requireTeamRole
//     whose thrown Response encodes the 401/403 gates
//
// Asserted:
//   - 401 anon, 403 below-member — opaque, body untouched.
//   - 400 malformed JSON body.
//   - 400 ids:[] (.min(1) — no empty-selection write path).
//   - 400 undisclosed field (.strict()).
//   - 400 ownerId cross-team (FK validation mirror PATCH /owner).
//   - 400 ownerId not an active workspace member.
//   - 200 happy path N ids: every row's ownerId flips to the
//     picked FK, envelope echoes {id, ownerId, ownerName} per row.
//   - 200 silent cross-team drop: cross-team ids never reach the
//     transaction nor the envelope.
//   - 200 snooze-arm drop: rows whose snoozedUntil > now are
//     silently skipped.
//   - defence-in-depth: cross-team write → opaque 404.
//   - 500 on DB throw.
//   - GET/PUT/PATCH/DELETE → 405 with Allow: POST.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const alertFindMany = vi.fn();
const alertFindFirst = vi.fn();
const alertFindUnique = vi.fn();
const alertUpdate = vi.fn();
const alertTransaction = vi.fn();
const workspaceMemberFindFirst = vi.fn();
const workspaceMemberFindMany = vi.fn();
const userFindUnique = vi.fn();
const userFindMany = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    alert: {
      findMany: alertFindMany,
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
    $transaction: alertTransaction,
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

function makePostRequest(body: unknown) {
  return new Request('http://test/api/alerts/assign-owner-batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Mock prisma.$transaction so the array-of-promises form
// (bulk route's atomic posture) just `Promise.all`s the inner
// promises. Pin the brief's "one transaction across N ids"
// contract.
function installTransactionShim() {
  alertTransaction.mockImplementation(async (arg: unknown) => {
    if (Array.isArray(arg)) {
      return Promise.all(arg.map((p) => Promise.resolve(p)));
    }
    return arg;
  });
}

beforeEach(() => {
  vi.resetModules();
  alertFindMany.mockReset();
  alertFindFirst.mockReset();
  alertFindUnique.mockReset();
  alertUpdate.mockReset();
  alertTransaction.mockReset();
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
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    },
    membership: { id: 'mem-1', userId: 'user-1', teamId: 'team-1', role: 'member' },
    team: { id: 'team-1', name: 'workspace' },
  });
  installTransactionShim();
  // Default FK-validation pass: workspaceMemberFindFirst returns
  // a valid active member of the on-team-1 workspace. Tests that
  // exercise the FK-validation branch override this resolution.
  workspaceMemberFindFirst.mockImplementation(
    async (args: { where: { id: string; workspaceId: string; status: string } }) => {
      if (args.where.id === 'wm-other-team') return null;
      return { id: args.where.id, userId: 'user-2', email: 'member@example.com' };
    },
  );
  userFindUnique.mockResolvedValue({ id: 'user-2', name: 'Picked Member' });
});

function makeScopeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-1',
    teamId: 'team-1',
    snoozedUntil: null,
    ...overrides,
  };
}

// ===================== POST /api/alerts/assign-owner-batch =====================

describe('POST /api/alerts/assign-owner-batch', () => {
  it('returns 401 when there is no session', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Unauthorized' }, { status: 401 });
    });
    const { POST } = await import('@/app/api/alerts/assign-owner-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'], ownerId: 'wm-2' }));
    expect(res.status).toBe(401);
    expect(workspaceMemberFindFirst).not.toHaveBeenCalled();
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertTransaction).not.toHaveBeenCalled();
  });

  it('returns 403 when caller is below member', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Forbidden' }, { status: 403 });
    });
    const { POST } = await import('@/app/api/alerts/assign-owner-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'], ownerId: 'wm-2' }));
    expect(res.status).toBe(403);
    expect(workspaceMemberFindFirst).not.toHaveBeenCalled();
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertTransaction).not.toHaveBeenCalled();
  });

  it('returns 400 when the body is malformed JSON', async () => {
    const req = new Request('http://test/api/alerts/assign-owner-batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    const { POST } = await import('@/app/api/alerts/assign-owner-batch/route');
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(workspaceMemberFindFirst).not.toHaveBeenCalled();
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertTransaction).not.toHaveBeenCalled();
  });

  it('returns 400 when ids is empty (.min(1))', async () => {
    const { POST } = await import('@/app/api/alerts/assign-owner-batch/route');
    const res = await POST(makePostRequest({ ids: [], ownerId: 'wm-2' }));
    expect(res.status).toBe(400);
    expect(workspaceMemberFindFirst).not.toHaveBeenCalled();
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertTransaction).not.toHaveBeenCalled();
  });

  it('returns 400 when an undisclosed field is included (.strict())', async () => {
    const { POST } = await import('@/app/api/alerts/assign-owner-batch/route');
    const res = await POST(
      makePostRequest({ ids: ['alert-1'], ownerId: 'wm-2', evilField: 'extra' }),
    );
    expect(res.status).toBe(400);
    expect(workspaceMemberFindFirst).not.toHaveBeenCalled();
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertTransaction).not.toHaveBeenCalled();
  });

  it('returns 400 when ownerId is cross-team (FK validation)', async () => {
    // Mirror PATCH /[id]/owner posture: a non-null ownerId MUST
    // resolve to an active WorkspaceMember in this workspace.
    // `wm-other-team` resolves to null on the gateway. The
    // route bails with `{errors: {ownerId: '…'}}` at 400 before
    // any alert read.
    workspaceMemberFindFirst.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/alerts/assign-owner-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'], ownerId: 'wm-other-team' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors).toBeDefined();
    expect(body.errors.ownerId).toMatch(/active member/i);
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertTransaction).not.toHaveBeenCalled();
  });

  it('returns 400 when ownerId is not an active workspace member', async () => {
    // The active filter rejects pending / removed members. FK
    // resolution returns null; the route surfaces the same
    // typed-field error as a cross-team id.
    workspaceMemberFindFirst.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/alerts/assign-owner-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'], ownerId: 'wm-removed' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors.ownerId).toMatch(/active member/i);
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertTransaction).not.toHaveBeenCalled();
  });

  it('happy path: 3 ids all get the picked ownerId stamped in one transaction', async () => {
    alertFindMany.mockResolvedValueOnce([
      makeScopeRow({ id: 'alert-1' }),
      makeScopeRow({ id: 'alert-2' }),
      makeScopeRow({ id: 'alert-3' }),
    ]);
    alertUpdate.mockImplementation(
      async (args: { where: { id: string }; data: { ownerId: string } }) => ({
        id: args.where.id,
        teamId: 'team-1',
        ownerId: args.data.ownerId,
      }),
    );
    const { POST } = await import('@/app/api/alerts/assign-owner-batch/route');
    const res = await POST(
      makePostRequest({ ids: ['alert-1', 'alert-2', 'alert-3'], ownerId: 'wm-2' }),
    );
    expect(res.status).toBe(200);
    expect(alertTransaction).toHaveBeenCalledTimes(1);
    expect(alertUpdate).toHaveBeenCalledTimes(3);
    // Every updated row has the picked FK.
    for (const call of alertUpdate.mock.calls) {
      const data = (call[0] as { data: { ownerId: string } }).data;
      expect(data.ownerId).toBe('wm-2');
    }
    const body = await res.json();
    expect(body.results).toHaveLength(3);
    expect(body.results.map((r: { id: string }) => r.id).sort()).toEqual([
      'alert-1',
      'alert-2',
      'alert-3',
    ]);
    // Every result row echoes the FK + the route's resolved
    // ownerName from the peer User.read (mocked default: 'Picked
    // Member').
    for (const r of body.results) {
      expect(r.ownerId).toBe('wm-2');
      expect(r.ownerName).toBe('Picked Member');
    }
  });

  it('ownerName resolves to null when User.name is missing', async () => {
    userFindUnique.mockResolvedValueOnce({ id: 'user-2', name: null });
    alertFindMany.mockResolvedValueOnce([makeScopeRow({ id: 'alert-1' })]);
    alertUpdate.mockImplementation(
      async (args: { where: { id: string }; data: { ownerId: string } }) => ({
        id: args.where.id,
        teamId: 'team-1',
        ownerId: args.data.ownerId,
      }),
    );
    const { POST } = await import('@/app/api/alerts/assign-owner-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'], ownerId: 'wm-2' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].ownerId).toBe('wm-2');
    expect(body.results[0].ownerName).toBeNull();
  });

  it('silent cross-team drop: cross-team ids never reach transaction nor envelope', async () => {
    alertFindMany.mockResolvedValueOnce([
      makeScopeRow({ id: 'a-in-team' }),
      makeScopeRow({ id: 'c-in-team' }),
    ]);
    alertUpdate.mockImplementation(
      async (args: { where: { id: string }; data: { ownerId: string } }) => ({
        id: args.where.id,
        teamId: 'team-1',
        ownerId: args.data.ownerId,
      }),
    );
    const { POST } = await import('@/app/api/alerts/assign-owner-batch/route');
    const res = await POST(
      makePostRequest({
        ids: ['a-in-team', 'b-cross-team', 'c-in-team'],
        ownerId: 'wm-2',
      }),
    );
    expect(res.status).toBe(200);
    const txArg = alertTransaction.mock.calls[0]?.[0];
    expect(Array.isArray(txArg)).toBe(true);
    expect((txArg as unknown[]).length).toBe(2);
    expect(alertUpdate).toHaveBeenCalledTimes(2);
    const updateIds = alertUpdate.mock.calls.map(
      (c) => (c[0] as { where: { id: string } }).where.id,
    );
    expect(updateIds.sort()).toEqual(['a-in-team', 'c-in-team']);
    expect(updateIds).not.toContain('b-cross-team');
    const body = await res.json();
    expect(body.results).toHaveLength(2);
    expect(body.results.map((r: { id: string }) => r.id).sort()).toEqual([
      'a-in-team',
      'c-in-team',
    ]);
  });

  it('snooze-arm drop: rows with future snoozedUntil are silently skipped', async () => {
    // Two non-snoozed rows PLUS one row whose snoozedUntil is
    // in the future. The snoozed row should be filtered out of
    // the live set before the transaction; transaction fires
    // only on the two non-snoozed ids.
    const FUTURE = new Date(Date.now() + 60 * 60 * 1000);
    alertFindMany.mockResolvedValueOnce([
      makeScopeRow({ id: 'open-1' }),
      makeScopeRow({ id: 'open-2' }),
      makeScopeRow({ id: 'future-snoozed', snoozedUntil: FUTURE }),
    ]);
    alertUpdate.mockImplementation(
      async (args: { where: { id: string }; data: { ownerId: string } }) => ({
        id: args.where.id,
        teamId: 'team-1',
        ownerId: args.data.ownerId,
      }),
    );
    const { POST } = await import('@/app/api/alerts/assign-owner-batch/route');
    const res = await POST(
      makePostRequest({ ids: ['open-1', 'open-2', 'future-snoozed'], ownerId: 'wm-2' }),
    );
    expect(res.status).toBe(200);
    const txArg = alertTransaction.mock.calls[0]?.[0];
    expect(Array.isArray(txArg)).toBe(true);
    expect((txArg as unknown[]).length).toBe(2);
    const updateIds = alertUpdate.mock.calls.map(
      (c) => (c[0] as { where: { id: string } }).where.id,
    );
    expect(updateIds.sort()).toEqual(['open-1', 'open-2']);
    expect(updateIds).not.toContain('future-snoozed');
    const body = await res.json();
    expect(body.results).toHaveLength(2);
    expect(body.results.map((r: { id: string }) => r.id).sort()).toEqual(['open-1', 'open-2']);
  });

  it('elapsed snooze (snoozedUntil in the past) is NOT dropped', async () => {
    // An elapsed snooze (snoozedUntil <= now) is treated like a
    // no-snooze row — the snooze-arm gate strictly checks
    // `snoozedUntil > now`, so elapsed snoozes still flow into
    // the transaction. Mirrors /api/alerts' "OR <= now" list
    // narrowing.
    const PAST = new Date(Date.now() - 60 * 60 * 1000);
    alertFindMany.mockResolvedValueOnce([
      makeScopeRow({ id: 'elapsed-snoozed', snoozedUntil: PAST }),
    ]);
    alertUpdate.mockImplementation(
      async (args: { where: { id: string }; data: { ownerId: string } }) => ({
        id: args.where.id,
        teamId: 'team-1',
        ownerId: args.data.ownerId,
      }),
    );
    const { POST } = await import('@/app/api/alerts/assign-owner-batch/route');
    const res = await POST(makePostRequest({ ids: ['elapsed-snoozed'], ownerId: 'wm-2' }));
    expect(res.status).toBe(200);
    expect(alertUpdate).toHaveBeenCalledTimes(1);
  });

  it('ownerId: null clears the FK on every row but does NOT echo rows in results', async () => {
    // The "Unassigned" arm: ownerId === null clears the FK on
    // every targeted row. The per-row
    // AlertBulkOwnershipRow.ownerId is a non-null literal
    // (the /ownership-batch wire contract), so the route
    // excludes cleared rows from the response envelope. The
    // FK column IS cleared on every row (the short-circuit
    // skips the FK-validation peer-read).
    alertFindMany.mockResolvedValueOnce([
      makeScopeRow({ id: 'alert-1' }),
      makeScopeRow({ id: 'alert-2' }),
    ]);
    alertUpdate.mockImplementation(
      async (args: { where: { id: string }; data: { ownerId: string | null } }) => ({
        id: args.where.id,
        teamId: 'team-1',
        ownerId: args.data.ownerId,
      }),
    );
    const { POST } = await import('@/app/api/alerts/assign-owner-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1', 'alert-2'], ownerId: null }));
    expect(res.status).toBe(200);
    // FK was cleared.
    for (const call of alertUpdate.mock.calls) {
      const data = (call[0] as { data: { ownerId: string | null } }).data;
      expect(data.ownerId).toBeNull();
    }
    const body = await res.json();
    expect(body.results).toEqual([]);
  });

  it('empty overlap: every id is cross-team/missing → HTTP 200 + empty envelope', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    const { POST } = await import('@/app/api/alerts/assign-owner-batch/route');
    const res = await POST(makePostRequest({ ids: ['missing-1'], ownerId: 'wm-2' }));
    expect(res.status).toBe(200);
    expect(alertTransaction).not.toHaveBeenCalled();
    expect(alertUpdate).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body).toEqual({ results: [] });
  });

  it('defence-in-depth: cross-team row in transaction result → opaque 404', async () => {
    alertFindMany.mockResolvedValueOnce([makeScopeRow({ id: 'alert-1' })]);
    alertUpdate.mockImplementationOnce(async () => ({
      id: 'alert-1',
      teamId: 'team-OTHER',
      ownerId: 'wm-2',
    }));
    const { POST } = await import('@/app/api/alerts/assign-owner-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'], ownerId: 'wm-2' }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'not_found' });
  });

  it('returns 500 when the FK validation throws', async () => {
    workspaceMemberFindFirst.mockRejectedValueOnce(new Error('db down'));
    const { POST } = await import('@/app/api/alerts/assign-owner-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'], ownerId: 'wm-2' }));
    expect(res.status).toBe(500);
  });

  it('returns 500 when the DB throws on the scope-check', async () => {
    alertFindMany.mockRejectedValueOnce(new Error('db down'));
    const { POST } = await import('@/app/api/alerts/assign-owner-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'], ownerId: 'wm-2' }));
    expect(res.status).toBe(500);
  });

  it('returns 500 when the $transaction throws', async () => {
    alertFindMany.mockResolvedValueOnce([makeScopeRow({ id: 'alert-1' })]);
    alertTransaction.mockRejectedValueOnce(new Error('write failed'));
    const { POST } = await import('@/app/api/alerts/assign-owner-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'], ownerId: 'wm-2' }));
    expect(res.status).toBe(500);
  });

  it('deduplicates duplicate ids in the request before the scope check', async () => {
    alertFindMany.mockResolvedValueOnce([
      makeScopeRow({ id: 'alert-1' }),
      makeScopeRow({ id: 'alert-2' }),
    ]);
    alertUpdate.mockImplementation(
      async (args: { where: { id: string }; data: { ownerId: string } }) => ({
        id: args.where.id,
        teamId: 'team-1',
        ownerId: args.data.ownerId,
      }),
    );
    const { POST } = await import('@/app/api/alerts/assign-owner-batch/route');
    const res = await POST(
      makePostRequest({ ids: ['alert-1', 'alert-1', 'alert-2'], ownerId: 'wm-2' }),
    );
    expect(res.status).toBe(200);
    expect(alertTransaction).toHaveBeenCalledTimes(1);
    const txArg = alertTransaction.mock.calls[0]?.[0];
    expect(Array.isArray(txArg)).toBe(true);
    expect((txArg as unknown[]).length).toBe(2);
    expect(alertUpdate).toHaveBeenCalledTimes(2);
    const body = await res.json();
    expect(body.results).toHaveLength(2);
  });
});

// ===================== Method guards =====================

describe('methodNotAllowed stubs for /api/alerts/assign-owner-batch', () => {
  it.each([['GET'], ['PUT'], ['PATCH'], ['DELETE']])(
    '%s returns 405 with Allow: POST',
    async (method) => {
      const routeModule = await import('@/app/api/alerts/assign-owner-batch/route');
      const handler = (routeModule as unknown as Record<string, () => Promise<Response>>)[
        method as string
      ];
      const res = await handler();
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('POST');
    },
  );
});
