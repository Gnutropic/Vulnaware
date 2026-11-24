// @vitest-environment node
// Unit tests for GET + POST /api/alerts/[id]/comments. Mirrors the
// posture of tests/unit/api/alerts-owner-route.test.ts +
// team-members-route.test.ts: vi.mock('server-only'),
// vi.mock('@/lib/db'), vi.mock('@/lib/team-auth') with a swappable
// requireTeamRole whose opaque Response throw encodes the 401/403 gates,
// vi.resetModules() in beforeEach so each test sees a fresh module.
//
// Asserted:
//   - GET/POST 401 + 403 opaque gates
//   - GET: opaque 404 on cross-team/missing alert; empty list envelope
//     when no comments; non-empty list with `authorName` resolved via
//     User.findMany; `authorName: null` when the User row is missing;
//     order is `asc` (oldest first); visibility widens to "assignee OR
//     anyone who has ever posted on the alert" — non-assignees who have
//     commented see the full thread, non-commenters stay narrowed to
//     their own posts.
//   - POST: opaque 404 (cross-team guard fires BEFORE the assignee 403);
//     400 on invalid JSON / trim-then-empty body / body length > 4000;
//     403 `not_assignee` when `alert.ownerId` points to a different
//     team member OR is null (no assignee ever → locked); 201 returns
//     the persisted row with `authorName` resolved via User.findUnique
//   - Lockstep GET → POST → GET proves server `asc` is wired end-to-end:
//     the count goes N → N+1 with the new row at the END of the list,
//     and the original N rows appear in (c) shifted UP by one index
//     (their relative order preserved, oldest first).
//   - 500 on DB error; PUT/PATCH/DELETE → 405 with `Allow: GET, POST`.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const alertFindFirst = vi.fn();
const alertCommentFindFirst = vi.fn();
const alertCommentFindMany = vi.fn();
const alertCommentCreate = vi.fn();
const workspaceMemberFindFirst = vi.fn();
const userFindMany = vi.fn();
const userFindUnique = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    alert: {
      findFirst: alertFindFirst,
    },
    alertComment: {
      findFirst: alertCommentFindFirst,
      findMany: alertCommentFindMany,
      create: alertCommentCreate,
    },
    workspaceMember: {
      findFirst: workspaceMemberFindFirst,
    },
    user: {
      findMany: userFindMany,
      findUnique: userFindUnique,
    },
  },
}));

const requireTeamRoleMock = vi.fn();

vi.mock('@/lib/team-auth', () => ({
  requireTeamRole: async () => requireTeamRoleMock(),
}));

const MEMBER_CTX = {
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
};

// Default: caller IS the assignee of alert-1 — caller's WorkspaceMember
// row id matches alert.ownerId so the assignee gate lets the POST through.
const CALLER_WORKSPACE_MEMBER_ID = 'wm-self';

function makeAlertRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-1',
    ownerId: CALLER_WORKSPACE_MEMBER_ID,
    ...overrides,
  };
}

function makeAlertCommentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cmt-1',
    alertId: 'alert-1',
    authorId: 'user-1',
    body: 'Investigating this morning.',
    createdAt: new Date('2026-01-02T00:00:00Z'),
    ...overrides,
  };
}

function makeGetRequest(id = 'alert-1') {
  return new Request(`http://test/api/alerts/${id}/comments`, { method: 'GET' });
}

function makePostRequest(body: unknown, id = 'alert-1') {
  return new Request(`http://test/api/alerts/${id}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

function makeInvalidJsonPostRequest(id = 'alert-1') {
  return new Request(`http://test/api/alerts/${id}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not-json',
  });
}

beforeEach(() => {
  vi.resetModules();
  alertFindFirst.mockReset();
  alertCommentFindFirst.mockReset();
  alertCommentFindMany.mockReset();
  alertCommentCreate.mockReset();
  workspaceMemberFindFirst.mockReset();
  userFindMany.mockReset();
  userFindUnique.mockReset();
  requireTeamRoleMock.mockReset();
  requireTeamRoleMock.mockResolvedValue(MEMBER_CTX);
});

// ===================== GET /api/alerts/[id]/comments =====================

describe('GET /api/alerts/[id]/comments', () => {
  it('returns 401 when there is no session', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Unauthorized' }, { status: 401 });
    });
    const { GET } = await import('@/app/api/alerts/[id]/comments/route');
    const res = await GET(makeGetRequest(), { params: Promise.resolve({ id: 'alert-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 403 when caller is below member', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Forbidden' }, { status: 403 });
    });
    const { GET } = await import('@/app/api/alerts/[id]/comments/route');
    const res = await GET(makeGetRequest(), { params: Promise.resolve({ id: 'alert-1' }) });
    expect(res.status).toBe(403);
  });

  it('returns opaque 404 when the alert belongs to a different team', async () => {
    alertFindFirst.mockResolvedValueOnce(null);
    const { GET } = await import('@/app/api/alerts/[id]/comments/route');
    const res = await GET(makeGetRequest(), { params: Promise.resolve({ id: 'alert-1' }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'not_found' });
    expect(alertCommentFindMany).not.toHaveBeenCalled();
  });

  it('returns an empty list envelope when no comments exist for the alert', async () => {
    alertFindFirst.mockResolvedValueOnce(makeAlertRow());
    alertCommentFindMany.mockResolvedValueOnce([]);
    const { GET } = await import('@/app/api/alerts/[id]/comments/route');
    const res = await GET(makeGetRequest(), { params: Promise.resolve({ id: 'alert-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ items: [] });
    // Empty rows means User.findMany is skipped entirely — cheap optimization.
    expect(userFindMany).not.toHaveBeenCalled();
  });

  it('returns rows with authorName resolved from User.findMany', async () => {
    alertFindFirst.mockResolvedValueOnce(makeAlertRow());
    alertCommentFindMany.mockResolvedValueOnce([
      makeAlertCommentRow({ id: 'cmt-A', authorId: 'user-1' }),
    ]);
    userFindMany.mockResolvedValueOnce([{ id: 'user-1', name: 'Member' }]);
    const { GET } = await import('@/app/api/alerts/[id]/comments/route');
    const res = await GET(makeGetRequest(), { params: Promise.resolve({ id: 'alert-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toEqual({
      id: 'cmt-A',
      alertId: 'alert-1',
      authorId: 'user-1',
      authorName: 'Member',
      body: 'Investigating this morning.',
      createdAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('returns authorName=null when the User row is missing for the authorId', async () => {
    alertFindFirst.mockResolvedValueOnce(makeAlertRow());
    alertCommentFindMany.mockResolvedValueOnce([
      makeAlertCommentRow({ id: 'cmt-A', authorId: 'user-gone' }),
    ]);
    // User.findMany returns no rows for the missing id.
    userFindMany.mockResolvedValueOnce([]);
    const { GET } = await import('@/app/api/alerts/[id]/comments/route');
    const res = await GET(makeGetRequest(), { params: Promise.resolve({ id: 'alert-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0].authorName).toBeNull();
  });

  it('requests comments in createdAt asc order (oldest first)', async () => {
    alertFindFirst.mockResolvedValueOnce(makeAlertRow());
    // Caller IS the assignee so the visibility lift is unconditional and
    // the probe never fires (probe is skipped when callerIsAssignee).
    workspaceMemberFindFirst.mockResolvedValueOnce({ id: CALLER_WORKSPACE_MEMBER_ID });
    alertCommentFindMany.mockResolvedValueOnce([]);
    const { GET } = await import('@/app/api/alerts/[id]/comments/route');
    await GET(makeGetRequest(), { params: Promise.resolve({ id: 'alert-1' }) });
    expect(alertCommentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { alertId: 'alert-1' },
        orderBy: { createdAt: 'asc' },
      }),
    );
  });

  it('non-assignee who has commented sees the full thread (assignee + commenters)', async () => {
    // Caller is a team member but NOT the assignee of alert-1. The probe
    // `findFirst` returns a row (caller has commented) → visibility lifts.
    // Sequence: alertFindFirst → workspaceMemberFindFirst → callerHasCommented
    // probe findFirst → thread findMany.
    alertFindFirst.mockResolvedValueOnce(makeAlertRow({ ownerId: 'wm-other' }));
    workspaceMemberFindFirst.mockResolvedValueOnce({ id: CALLER_WORKSPACE_MEMBER_ID });
    // Caller has at least one comment on this alert → probe returns a row.
    alertCommentFindFirst.mockResolvedValueOnce({ id: 'cmt-caller' });
    // The thread read returns the full set of co-author rows.
    alertCommentFindMany.mockResolvedValueOnce([
      makeAlertCommentRow({
        id: 'cmt-r1',
        authorId: 'user-assignee',
        body: 'Investigating.',
        createdAt: new Date('2026-01-02T00:00:00Z'),
      }),
      makeAlertCommentRow({
        id: 'cmt-r2',
        authorId: 'user-1',
        body: 'Any update?',
        createdAt: new Date('2026-01-03T00:00:00Z'),
      }),
      makeAlertCommentRow({
        id: 'cmt-r3',
        authorId: 'user-other',
        body: 'Confirmed repro.',
        createdAt: new Date('2026-01-04T00:00:00Z'),
      }),
    ]);
    userFindMany.mockResolvedValueOnce([
      { id: 'user-assignee', name: 'Assignee' },
      { id: 'user-1', name: 'Member' },
      { id: 'user-other', name: 'Other' },
    ]);
    const { GET } = await import('@/app/api/alerts/[id]/comments/route');
    const res = await GET(makeGetRequest(), { params: Promise.resolve({ id: 'alert-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(['cmt-r1', 'cmt-r2', 'cmt-r3']);
    // Thread findMany was NOT narrowed by authorId — caller has commented.
    const threadCall = alertCommentFindMany.mock.calls.at(-1)?.[0];
    expect(threadCall).toMatchObject({
      where: { alertId: 'alert-1' },
      orderBy: { createdAt: 'asc' },
    });
    expect(threadCall.where).not.toHaveProperty('authorId');
  });

  it('team member who has never commented still sees only their own posts', async () => {
    // Caller is a team member, not the assignee, and no row exists with
    // `authorId === ctx.user.id` on this alert → probe returns null →
    // visibility stays narrowed.
    alertFindFirst.mockResolvedValueOnce(makeAlertRow({ ownerId: 'wm-other' }));
    workspaceMemberFindFirst.mockResolvedValueOnce({ id: CALLER_WORKSPACE_MEMBER_ID });
    // Caller has no comment on this alert → probe returns null.
    alertCommentFindFirst.mockResolvedValueOnce(null);
    // Thread read narrows to caller's own row.
    alertCommentFindMany.mockResolvedValueOnce([
      makeAlertCommentRow({ id: 'cmt-self', authorId: 'user-1' }),
    ]);
    userFindMany.mockResolvedValueOnce([{ id: 'user-1', name: 'Member' }]);
    const { GET } = await import('@/app/api/alerts/[id]/comments/route');
    const res = await GET(makeGetRequest(), { params: Promise.resolve({ id: 'alert-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(['cmt-self']);
    const threadCall = alertCommentFindMany.mock.calls.at(-1)?.[0];
    expect(threadCall).toMatchObject({
      where: { alertId: 'alert-1', authorId: 'user-1' },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('returns 500 on DB error', async () => {
    alertFindFirst.mockRejectedValueOnce(new Error('db down'));
    const { GET } = await import('@/app/api/alerts/[id]/comments/route');
    const res = await GET(makeGetRequest(), { params: Promise.resolve({ id: 'alert-1' }) });
    expect(res.status).toBe(500);
  });
});

// ===================== POST /api/alerts/[id]/comments =====================

describe('POST /api/alerts/[id]/comments', () => {
  it('returns 401 when there is no session', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Unauthorized' }, { status: 401 });
    });
    const { POST } = await import('@/app/api/alerts/[id]/comments/route');
    const res = await POST(makePostRequest({ body: 'Working on it.' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(401);
    expect(alertCommentCreate).not.toHaveBeenCalled();
  });

  it('returns 403 when caller is below member', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Forbidden' }, { status: 403 });
    });
    const { POST } = await import('@/app/api/alerts/[id]/comments/route');
    const res = await POST(makePostRequest({ body: 'Working on it.' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(403);
    expect(alertCommentCreate).not.toHaveBeenCalled();
  });

  it('returns 400 when the body is invalid JSON', async () => {
    const { POST } = await import('@/app/api/alerts/[id]/comments/route');
    const res = await POST(makeInvalidJsonPostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(400);
    expect(alertCommentCreate).not.toHaveBeenCalled();
  });

  it('returns 400 when the body is empty after trim', async () => {
    const { POST } = await import('@/app/api/alerts/[id]/comments/route');
    const res = await POST(makePostRequest({ body: '   ' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors?.body).toMatch(/empty/i);
    expect(alertCommentCreate).not.toHaveBeenCalled();
  });

  it('returns 400 when the body exceeds 4000 characters', async () => {
    const { POST } = await import('@/app/api/alerts/[id]/comments/route');
    const res = await POST(makePostRequest({ body: 'x'.repeat(4001) }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors?.body).toMatch(/too long/i);
    expect(alertCommentCreate).not.toHaveBeenCalled();
  });

  it('returns opaque 404 when the alert belongs to a different team', async () => {
    // Cross-team guard fires BEFORE the assignee gate — a probe can't
    // sniff row existence via 403-vs-404.
    alertFindFirst.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/alerts/[id]/comments/route');
    const res = await POST(makePostRequest({ body: 'Working on it.' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'not_found' });
    // Assignee gate skipped — workspaceMember.findFirst never runs.
    expect(workspaceMemberFindFirst).not.toHaveBeenCalled();
    expect(alertCommentCreate).not.toHaveBeenCalled();
  });

  it('returns 403 not_assignee when another team member owns the alert', async () => {
    alertFindFirst.mockResolvedValueOnce(makeAlertRow({ ownerId: 'wm-other' }));
    workspaceMemberFindFirst.mockResolvedValueOnce({ id: CALLER_WORKSPACE_MEMBER_ID });
    const { POST } = await import('@/app/api/alerts/[id]/comments/route');
    const res = await POST(makePostRequest({ body: 'Working on it.' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: 'not_assignee' });
    expect(alertCommentCreate).not.toHaveBeenCalled();
  });

  it('returns 403 not_assignee when ownerId is null (no assignee ever)', async () => {
    alertFindFirst.mockResolvedValueOnce(makeAlertRow({ ownerId: null }));
    workspaceMemberFindFirst.mockResolvedValueOnce({ id: CALLER_WORKSPACE_MEMBER_ID });
    const { POST } = await import('@/app/api/alerts/[id]/comments/route');
    const res = await POST(makePostRequest({ body: 'Working on it.' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: 'not_assignee' });
    expect(alertCommentCreate).not.toHaveBeenCalled();
  });

  it('persists the row and returns 201 with authorName resolved via User.findUnique', async () => {
    alertFindFirst.mockResolvedValueOnce(makeAlertRow());
    workspaceMemberFindFirst.mockResolvedValueOnce({ id: CALLER_WORKSPACE_MEMBER_ID });
    alertCommentCreate.mockResolvedValueOnce(
      makeAlertCommentRow({
        id: 'cmt-new',
        authorId: 'user-1',
        body: 'Working on it.',
        createdAt: new Date('2026-01-05T00:00:00Z'),
      }),
    );
    userFindUnique.mockResolvedValueOnce({ name: 'Member' });
    const { POST } = await import('@/app/api/alerts/[id]/comments/route');
    const res = await POST(makePostRequest({ body: 'Working on it.' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(201);
    // Persist call uses the trimmed body + caller identity + alertId.
    expect(alertCommentCreate).toHaveBeenCalledWith({
      data: { alertId: 'alert-1', authorId: 'user-1', body: 'Working on it.' },
      select: expect.objectContaining({
        id: true,
        alertId: true,
        authorId: true,
        body: true,
        createdAt: true,
      }),
    });
    const body = await res.json();
    expect(body).toEqual({
      id: 'cmt-new',
      alertId: 'alert-1',
      authorId: 'user-1',
      authorName: 'Member',
      body: 'Working on it.',
      createdAt: '2026-01-05T00:00:00.000Z',
    });
  });

  it('persists a trimmed body (leading/trailing whitespace stripped server-side)', async () => {
    alertFindFirst.mockResolvedValueOnce(makeAlertRow());
    workspaceMemberFindFirst.mockResolvedValueOnce({ id: CALLER_WORKSPACE_MEMBER_ID });
    alertCommentCreate.mockResolvedValueOnce(makeAlertCommentRow({ id: 'cmt-new', body: 'hello' }));
    userFindUnique.mockResolvedValueOnce({ name: 'Member' });
    const { POST } = await import('@/app/api/alerts/[id]/comments/route');
    const res = await POST(makePostRequest({ body: '  hello  ' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(201);
    expect(alertCommentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ body: 'hello' }) }),
    );
  });

  it('returns 500 on DB error during persist', async () => {
    alertFindFirst.mockResolvedValueOnce(makeAlertRow());
    workspaceMemberFindFirst.mockResolvedValueOnce({ id: CALLER_WORKSPACE_MEMBER_ID });
    alertCommentCreate.mockRejectedValueOnce(new Error('db down'));
    const { POST } = await import('@/app/api/alerts/[id]/comments/route');
    const res = await POST(makePostRequest({ body: 'Working on it.' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(500);
  });
});

// ===================== Lockstep GET → POST → GET =====================

describe('LOCKSTEP GET → POST → GET (server asc + client append)', () => {
  it('a freshly posted comment appears at the END of the next GET, and prior rows shift up by one', async () => {
    // Snapshot (a): GET returns N=2 rows in asc order (oldest first).
    //   Index 0: cmt-r1 (older, at snapshot time)
    //   Index 1: cmt-r2 (newer)
    alertFindFirst.mockResolvedValue(makeAlertRow());
    alertCommentFindMany.mockResolvedValueOnce([
      makeAlertCommentRow({
        id: 'cmt-r1',
        body: 'first',
        createdAt: new Date('2026-01-03T00:00:00Z'),
      }),
      makeAlertCommentRow({
        id: 'cmt-r2',
        body: 'second',
        createdAt: new Date('2026-01-04T00:00:00Z'),
      }),
    ]);
    userFindMany.mockResolvedValueOnce([
      { id: 'user-1', name: 'Member' },
      { id: 'user-1', name: 'Member' },
    ]);

    const { GET, POST } = await import('@/app/api/alerts/[id]/comments/route');

    const initialRes = await GET(makeGetRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    const initialBody = await initialRes.json();
    const initialCount = initialBody.items.length;
    expect(initialCount).toBe(2);
    expect(initialBody.items[0].body).toBe('first');
    expect(initialBody.items[1].body).toBe('second');

    // Step (b): POST creates a third comment. The create call returns
    // the just-persisted row with a fresh createdAt; the user lookup
    // resolves `authorName`.
    workspaceMemberFindFirst.mockResolvedValueOnce({ id: CALLER_WORKSPACE_MEMBER_ID });
    alertCommentCreate.mockResolvedValueOnce(
      makeAlertCommentRow({
        id: 'cmt-new',
        body: 'fresh',
        createdAt: new Date('2026-01-05T00:00:00Z'),
      }),
    );
    userFindUnique.mockResolvedValueOnce({ name: 'Member' });

    const postRes = await POST(makePostRequest({ body: 'fresh' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(postRes.status).toBe(201);

    // Step (c): GET returns N+1 = 3 rows in asc order.
    //   Index 0: cmt-r1 (was index 0 in step (a))
    //   Index 1: cmt-r2 (was index 1 in step (a))
    //   Index 2: cmt-new (newest, freshly appended)
    alertCommentFindMany.mockResolvedValueOnce([
      makeAlertCommentRow({
        id: 'cmt-r1',
        body: 'first',
        createdAt: new Date('2026-01-03T00:00:00Z'),
      }),
      makeAlertCommentRow({
        id: 'cmt-r2',
        body: 'second',
        createdAt: new Date('2026-01-04T00:00:00Z'),
      }),
      makeAlertCommentRow({
        id: 'cmt-new',
        body: 'fresh',
        createdAt: new Date('2026-01-05T00:00:00Z'),
      }),
    ]);
    userFindMany.mockResolvedValueOnce([{ id: 'user-1', name: 'Member' }]);

    const nextRes = await GET(makeGetRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    const nextBody = await nextRes.json();
    expect(nextBody.items.length).toBe(initialCount + 1);
    // New comment is the newest → appended at the end.
    expect(nextBody.items[nextBody.items.length - 1].id).toBe('cmt-new');
    expect(nextBody.items[nextBody.items.length - 1].body).toBe('fresh');
    // The original rows retain their relative order, shifted up by 1,
    // with the new row at the end.
    expect(nextBody.items.map((i: { id: string }) => i.id)).toEqual([
      'cmt-r1',
      'cmt-r2',
      'cmt-new',
    ]);
    // Wire integrity: alertId / authorId / createdAt preserved across the wire.
    const last = nextBody.items[nextBody.items.length - 1];
    expect(last.alertId).toBe('alert-1');
    expect(last.authorId).toBe('user-1');
    expect(last.createdAt).toBe('2026-01-05T00:00:00.000Z');
  });
});

// ===================== Method guards =====================

describe('methodNotAllowed stubs for /api/alerts/[id]/comments', () => {
  it.each([['PUT'], ['PATCH'], ['DELETE']])(
    '%s returns 405 with Allow: GET, POST',
    async (method) => {
      const routeModule = await import('@/app/api/alerts/[id]/comments/route');
      const handler = (routeModule as unknown as Record<string, () => Promise<Response>>)[method];
      const res = await handler();
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('GET, POST');
    },
  );
});
