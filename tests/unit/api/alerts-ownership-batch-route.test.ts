// @vitest-environment node
// Unit tests for POST /api/alerts/ownership-batch — the per-id bulk
// ownership-transfer companion to POST /api/alerts/[id]/claim (or
// PATCH /api/alerts/[id]/owner). Posture mirrors
// tests/unit/api/alerts-snooze-batch-route.test.ts but adjusts for
// the deltas that drive the bulk-take gesture:
//
//   - vi.mock('server-only') so the module loads
//   - vi.mock('@/lib/db') exposing the prisma.alert.{findMany,update}
//     surface AND prisma.workspaceMember.{findFirst,findMany} +
//     prisma.user.findUnique (the route resolves the caller's
//     WorkspaceMember + display name once at the top)
//   - vi.mock('@/lib/team-auth') with a swappable requireTeamRole
//     whose thrown Response encodes the 401/403 gates
//
// Asserted:
//   - 401 anon, 403 below-member — opaque, body untouched by the
//     route's parse step.
//   - 400 malformed JSON body.
//   - 400 ids:[] (.min(1) — no empty-selection write path).
//   - 400 undisclosed field (.strict()).
//   - 200 happy path N ids: every row's `ownerId` flips to
//     `callerWorkspaceMember.id`, envelope echoes {id, ownerId,
//     ownerName} per row.
//   - 200 partial: some already-owned rows surface in `conflicts[]`
//     (HTTP 200, NOT 409), transfer-side rows go to `results[]`.
//   - 200 all already-owned: envelope is `{results: [], conflicts:
//     ids}`, no `alert.update` calls fire (per-id already-owned
//     branch short-circuits BEFORE the UPDATE).
//   - 200 silent cross-team drop: cross-team ids never reach the
//     per-id UPDATE, never echo in either envelope arm. Diverges
//     from /[id]/claim's opaque 404.
//   - 200 empty overlap: every id cross-team/missing → envelope is
//     `{results: [], conflicts: []}`, HTTP 200, no `alert.update`.
//   - defence-in-depth: cross-team write on the per-id UPDATE row
//     → opaque 404.
//   - 500 on DB throw.
//   - GET/PUT/PATCH/DELETE → 405 with Allow: POST.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const alertFindMany = vi.fn();
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
  return new Request('http://test/api/alerts/ownership-batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeScopeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-1',
    teamId: 'team-1',
    ownerId: 'wm-OTHER',
    ...overrides,
  };
}

function makeOwnedRow(id: string, ownerId = 'wm-1') {
  return makeScopeRow({ id, ownerId });
}

function makeCallerMemberRow() {
  return { id: 'wm-1', userId: 'user-1', email: 'member@example.com' };
}

function makeCallerUserRow(name: string | null = 'Member') {
  return { id: 'user-1', name };
}

beforeEach(() => {
  vi.resetModules();
  alertFindMany.mockReset();
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
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    },
    membership: { id: 'mem-1', userId: 'user-1', teamId: 'team-1', role: 'member' },
    team: { id: 'team-1', name: 'workspace' },
  });
  // Default call resolution: the route peer-reads caller
  // WorkspaceMember + User at the top of POST before the scope
  // gate. Tests that pass through these calls register those
  // mocks; tests that don't reach the body parse path never fire
  // them.
  workspaceMemberFindFirst.mockResolvedValue(makeCallerMemberRow());
  userFindUnique.mockResolvedValue(makeCallerUserRow());
});

// ===================== POST /api/alerts/ownership-batch =====================

describe('POST /api/alerts/ownership-batch', () => {
  it('returns 401 when there is no session', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Unauthorized' }, { status: 401 });
    });
    const { POST } = await import('@/app/api/alerts/ownership-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'] }));
    expect(res.status).toBe(401);
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('returns 403 when caller is below member', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Forbidden' }, { status: 403 });
    });
    const { POST } = await import('@/app/api/alerts/ownership-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'] }));
    expect(res.status).toBe(403);
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('returns 400 when the body is malformed JSON', async () => {
    const req = new Request('http://test/api/alerts/ownership-batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    const { POST } = await import('@/app/api/alerts/ownership-batch/route');
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('returns 400 when ids is empty (.min(1))', async () => {
    const { POST } = await import('@/app/api/alerts/ownership-batch/route');
    const res = await POST(makePostRequest({ ids: [] }));
    expect(res.status).toBe(400);
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('returns 400 when an undisclosed field is included (.strict())', async () => {
    const { POST } = await import('@/app/api/alerts/ownership-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'], ownerId: 'wm-other' }));
    expect(res.status).toBe(400);
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('happy path: 3 unowned ids all get the caller WorkspaceMember.id stamped', async () => {
    // Three rows whose ownerId is some OTHER member (not the
    // caller). The per-id UPDATE flips ownerId to `wm-1`.
    alertFindMany.mockResolvedValueOnce([
      makeScopeRow({ id: 'alert-1', ownerId: 'wm-OTHER' }),
      makeScopeRow({ id: 'alert-2', ownerId: 'wm-OTHER' }),
      makeScopeRow({ id: 'alert-3', ownerId: 'wm-2' }),
    ]);
    alertUpdate.mockImplementation(
      async (args: { where: { id: string }; data: { ownerId: string } }) => ({
        id: args.where.id,
        teamId: 'team-1',
        ownerId: args.data.ownerId,
      }),
    );
    const { POST } = await import('@/app/api/alerts/ownership-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1', 'alert-2', 'alert-3'] }));
    expect(res.status).toBe(200);
    expect(alertUpdate).toHaveBeenCalledTimes(3);
    // Every update's destination is the caller WorkspaceMember.id.
    for (const call of alertUpdate.mock.calls) {
      const data = (call[0] as { data: { ownerId: string } }).data;
      expect(data.ownerId).toBe('wm-1');
    }
    const body = await res.json();
    expect(body.results).toHaveLength(3);
    expect(body.conflicts).toHaveLength(0);
    // Every result row echoes the FK (caller WM id) + the caller
    // User.name resolved at the top of the route.
    for (const r of body.results) {
      expect(r.ownerId).toBe('wm-1');
      expect(r.ownerName).toBe('Member');
    }
  });

  it('partial: some already-owned rows surface in `conflicts[]` (HTTP 200, NOT 409)', async () => {
    // Two rows already owned by caller; one row owned by ANOTHER
    // member. The bulk route stamps the unowned row into
    // `results[]` and reports the two already-owned rows via
    // `conflicts[]` — HTTP stays 200 on the partial arm (the
    // brief's "without failure" stance for already-owned rows).
    alertFindMany.mockResolvedValueOnce([
      makeOwnedRow('a-already-owned', 'wm-1'),
      makeOwnedRow('b-already-owned', 'wm-1'),
      makeScopeRow({ id: 'c-needs-transfer', ownerId: 'wm-OTHER' }),
    ]);
    alertUpdate.mockImplementation(
      async (args: { where: { id: string }; data: { ownerId: string } }) => ({
        id: args.where.id,
        teamId: 'team-1',
        ownerId: args.data.ownerId,
      }),
    );
    const { POST } = await import('@/app/api/alerts/ownership-batch/route');
    const res = await POST(
      makePostRequest({ ids: ['a-already-owned', 'b-already-owned', 'c-needs-transfer'] }),
    );
    expect(res.status).toBe(200);
    expect(alertUpdate).toHaveBeenCalledTimes(1);
    const updateId = (alertUpdate.mock.calls[0]?.[0] as { where: { id: string } }).where.id;
    expect(updateId).toBe('c-needs-transfer');
    const body = await res.json();
    // Transfer-side envelope.
    expect(body.results).toHaveLength(1);
    expect(body.results[0].id).toBe('c-needs-transfer');
    expect(body.results[0].ownerId).toBe('wm-1');
    // Conflict-arm envelope — already-owned rows are reported via
    // `conflicts[]` (NOT 409, NOT `failed[]`).
    expect(body.conflicts).toHaveLength(2);
    expect(body.conflicts.map((c: { id: string }) => c.id).sort()).toEqual([
      'a-already-owned',
      'b-already-owned',
    ]);
    for (const c of body.conflicts) {
      expect(c.ownerId).toBe('wm-1');
    }
  });

  it('all already-owned: results=[], conflicts=ids, no alert.update fires', async () => {
    // The brief's "without failure" envelope for the
    // already-owned fully-selected case: every id is silently
    // reported via the conflict arm; no UPDATE fires because the
    // per-id already-owned gate short-circuits BEFORE writing.
    // This is also the silent re-claim case the page-side helper
    // pre-filter handles for normal selections — but a stale
    // post-mount reassignment race can still send already-owned
    // ids over the wire.
    alertFindMany.mockResolvedValueOnce([
      makeOwnedRow('a-already-owned', 'wm-1'),
      makeOwnedRow('b-already-owned', 'wm-1'),
      makeOwnedRow('c-already-owned', 'wm-1'),
    ]);
    const { POST } = await import('@/app/api/alerts/ownership-batch/route');
    const res = await POST(
      makePostRequest({ ids: ['a-already-owned', 'b-already-owned', 'c-already-owned'] }),
    );
    expect(res.status).toBe(200);
    expect(alertUpdate).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.results).toHaveLength(0);
    expect(body.conflicts.map((c: { id: string }) => c.id).sort()).toEqual([
      'a-already-owned',
      'b-already-owned',
      'c-already-owned',
    ]);
    for (const c of body.conflicts) expect(c.ownerId).toBe('wm-1');
  });

  it('silent cross-team drop: cross-team ids never reach per-id UPDATE nor envelope', async () => {
    // Pin the deliberate divergence from /[id]/claim's opaque-404
    // posture: every cross-team id is filtered out of the
    // working set by the scope check; the route runs per-id
    // updates ONLY on the in-team rows. A copy-paste drift back
    // to 404 fails this test.
    alertFindMany.mockResolvedValueOnce([
      makeScopeRow({ id: 'a-in-team', ownerId: 'wm-OTHER' }),
      makeScopeRow({ id: 'c-in-team', ownerId: 'wm-OTHER' }),
    ]);
    alertUpdate.mockImplementation(
      async (args: { where: { id: string }; data: { ownerId: string } }) => ({
        id: args.where.id,
        teamId: 'team-1',
        ownerId: args.data.ownerId,
      }),
    );
    const { POST } = await import('@/app/api/alerts/ownership-batch/route');
    const res = await POST(
      makePostRequest({
        ids: ['a-in-team', 'b-cross-team', 'c-in-team'],
      }),
    );
    expect(res.status).toBe(200);
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
    expect(body.conflicts).toHaveLength(0);
  });

  it('empty overlap: every id is cross-team/missing → {results: [], conflicts: []}, HTTP 200', async () => {
    // Brief divergence from /[id]/claim: even when ALL ids are
    // missing/cross-team, the route returns 200 with empty both
    // envelopes (NOT 404).
    alertFindMany.mockResolvedValueOnce([]);
    const { POST } = await import('@/app/api/alerts/ownership-batch/route');
    const res = await POST(makePostRequest({ ids: ['missing-1', 'missing-2'] }));
    expect(res.status).toBe(200);
    expect(alertUpdate).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body).toEqual({ results: [], conflicts: [] });
  });

  it('caller name is null when user.name is missing → ownerName null on every result row', async () => {
    // The picker / list endpoint collapse "null name" to a
    // placeholder label without an extra round trip; the route
    // mirrors that posture on the response envelope by writing
    // null when the resolved User.name is missing.
    userFindUnique.mockResolvedValueOnce({ id: 'user-1', name: null });
    alertFindMany.mockResolvedValueOnce([makeScopeRow({ id: 'alert-1', ownerId: 'wm-OTHER' })]);
    alertUpdate.mockImplementation(
      async (args: { where: { id: string }; data: { ownerId: string } }) => ({
        id: args.where.id,
        teamId: 'team-1',
        ownerId: args.data.ownerId,
      }),
    );
    const { POST } = await import('@/app/api/alerts/ownership-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].ownerId).toBe('wm-1');
    expect(body.results[0].ownerName).toBeNull();
  });

  it('caller WorkspaceMember row missing → opaque 404', async () => {
    // Pact-defensive: a missing roster row can't happen given
    // `requireTeamRole` succeeded, but a bootstrap inconsistency
    // is surfaced as opaque 404 rather than a 500 so the page
    // doesn't have to special-case the missing-roster branch.
    workspaceMemberFindFirst.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/alerts/ownership-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'] }));
    expect(res.status).toBe(404);
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('defence-in-depth: cross-team row in the per-id update return → opaque 404', async () => {
    // Pact-defensive: a tampered race produced a cross-team row
    // in the per-id UPDATE result. The route SHOULD bail to
    // opaque 404 inside the defence-in-depth check even though
    // the scope-pass already filtered cross-team ids out.
    alertFindMany.mockResolvedValueOnce([makeScopeRow({ id: 'alert-1', ownerId: 'wm-OTHER' })]);
    alertUpdate.mockImplementationOnce(async () => ({
      id: 'alert-1',
      teamId: 'team-OTHER',
      ownerId: 'wm-1',
    }));
    const { POST } = await import('@/app/api/alerts/ownership-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'] }));
    expect(res.status).toBe(404);
  });

  it('500 on DB throw inside the body-handler', async () => {
    // Mirror the snooze-batch posture: an unexpected throw inside
    // the route's DB read fans out into a 500 catch-all. The page
    // surfaces the failure through the helper's `'err'`
    // outcome-map branch — a single failure marks every candidate
    // id as 'err' so the bar paints the red indicator strip.
    alertFindMany.mockImplementationOnce(async () => {
      throw new Error('prisma down');
    });
    const { POST } = await import('@/app/api/alerts/ownership-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'] }));
    expect(res.status).toBe(500);
  });

  it('GET → 405 with Allow: POST', async () => {
    const { GET } = await import('@/app/api/alerts/ownership-batch/route');
    const res = await GET();
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
  });

  it('PUT → 405 with Allow: POST', async () => {
    const { PUT } = await import('@/app/api/alerts/ownership-batch/route');
    const res = await PUT();
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
  });

  it('PATCH → 405 with Allow: POST', async () => {
    const { PATCH } = await import('@/app/api/alerts/ownership-batch/route');
    const res = await PATCH();
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
  });

  it('DELETE → 405 with Allow: POST', async () => {
    const { DELETE } = await import('@/app/api/alerts/ownership-batch/route');
    const res = await DELETE();
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
  });
});
