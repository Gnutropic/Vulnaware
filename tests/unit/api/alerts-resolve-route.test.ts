// @vitest-environment node
// Unit tests for POST /api/alerts/[id]/resolve. Posture mirrors
// tests/unit/api/alerts-owner-route.test.ts:
//   - vi.mock('server-only') so the module loads
//   - vi.mock('@/lib/db') exposing the prisma.alert.{findFirst,findUnique,update}
//     surface the route touches
//   - vi.mock('@/lib/require-auth') with a swappable session user
//   - vi.mock('@/lib/business/alert-workspace-access') with a swappable
//     authorized workspace-member context
//
// Asserted:
//   - 400 malformed body (missing JSON / >500-char note / undisclosed
//     field via `.strict()`)
//   - 401 anon, 404 without an active selected-workspace member — opaque
//   - 404 opaque cross-workspace (no UPDATE fired)
//   - 200 idempotent re-resolve: existing status: 'resolved' returns
//     the same envelope (with close-stamp trio preserved) without a
//     prisma.write when no note is in the body
//   - 200 idempotent re-resolve WITH a note: a partial UPDATE fires
//     for `closingNote` + `statusChangedAt` only — `closedAt` /
//     `closedBy` are preserved (NOT overwritten) since they encode
//     first-write identity.
//   - 200 transition from 'open' or 'in_progress' → 'resolved' flips
//     status + statusChangedAt + the close-stamp trio (closedAt,
//     closedBy, optional closingNote)
//   - 500 on DB throw
//   - On FIRST-write dispatch: alertResolvedEmail fires to the owner +
//     distinct AlertNote-thread watchers (resolver excluded); .catch
//     swallows proxy rejections so the envelope response still 2xx's.
//   - On FIRST-write: unowned alerts skip the dispatch entirely.
//   - On FIRST-write: self-resolve (caller IS the owner) skips the
//     dispatch entirely.
//   - On no-body re-resolve: no dispatch fires (no UPDATE, no email).
//   - GET/PUT/PATCH/DELETE → 405 with Allow: POST

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const alertFindFirst = vi.fn();
const alertUpdate = vi.fn();

// Dispatch-read mocks (set to safe defaults so the existing FIRST-write
// tests, which don't care about email, take the "no owner" branch
// without firing any sendEmail).
const workspaceMemberFindFirst = vi.fn();
const alertNoteFindMany = vi.fn();
const userFindUnique = vi.fn();
const userFindMany = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    alert: {
      findFirst: alertFindFirst,
      update: alertUpdate,
    },
    workspaceMember: {
      findFirst: workspaceMemberFindFirst,
    },
    alertNote: {
      findMany: alertNoteFindMany,
    },
    user: {
      findUnique: userFindUnique,
      findMany: userFindMany,
    },
  },
}));

// Pin the public URL so the dispatch layer builds a deterministic
// `${base}/alerts/${id}` deep link.
const envValues: Record<string, string | undefined> = {
  NEXT_PUBLIC_APP_URL: 'https://test.example.com',
  POLSIA_API_KEY: 'test-key',
};
vi.mock('@/lib/env', () => ({
  env: new Proxy(
    {},
    {
      get(_t, prop: string) {
        return envValues[prop];
      },
    },
  ),
}));

const sendEmailMock = vi.fn();
vi.mock('@/lib/email/send', () => ({
  sendEmail: sendEmailMock,
}));

const requireAlertWorkspaceMemberMock = vi.fn();

vi.mock('@/lib/business/alert-workspace-access', () => ({
  requireAlertWorkspaceMember: requireAlertWorkspaceMemberMock,
}));

const RESOLVED_AT = new Date('2026-07-01T12:00:00Z');

function makePostRequest(body: unknown = {}, id = 'alert-1') {
  return new Request(`http://test/api/alerts/${id}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeOpenRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-1',
    teamId: 'team-1',
    status: 'open',
    statusChangedAt: null,
    acknowledgedAt: null,
    falsePositiveReason: null,
    closedAt: null,
    closedBy: null,
    closingNote: null,
    reopenedAt: null,
    reopenedBy: null,
    reopenReason: null,
    ...overrides,
  };
}

function makeResolvedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-1',
    teamId: 'team-1',
    status: 'resolved',
    statusChangedAt: RESOLVED_AT,
    acknowledgedAt: new Date('2026-06-30T08:30:00Z'),
    falsePositiveReason: null,
    closedAt: RESOLVED_AT,
    closedBy: 'user-1',
    closingNote: 'Closed in scope',
    reopenedAt: null,
    reopenedBy: null,
    reopenReason: null,
    ...overrides,
  };
}

function makeResolvedUpdatedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-1',
    teamId: 'team-1',
    status: 'resolved',
    statusChangedAt: RESOLVED_AT,
    acknowledgedAt: null,
    closedAt: RESOLVED_AT,
    closedBy: 'user-1',
    closingNote: 'Closed in scope',
    reopenedAt: null,
    reopenedBy: null,
    reopenReason: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  alertFindFirst.mockReset();
  alertUpdate.mockReset();
  workspaceMemberFindFirst.mockReset();
  alertNoteFindMany.mockReset();
  userFindUnique.mockReset();
  userFindMany.mockReset();
  sendEmailMock.mockReset();
  requireAlertWorkspaceMemberMock.mockReset();
  requireAlertWorkspaceMemberMock.mockResolvedValue({
    user: {
      id: 'user-1',
      role: 'user',
      email: 'member@example.com',
      name: 'Member',
      emailVerified: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    },
    workspaceId: 'team-1',
    workspaceMemberId: 'mem-1',
  });
});

// ===================== POST /api/alerts/[id]/resolve =====================

describe('POST /api/alerts/[id]/resolve', () => {
  it('returns 401 when there is no session', async () => {
    requireAlertWorkspaceMemberMock.mockRejectedValueOnce(
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
    );
    const { POST } = await import('@/app/api/alerts/[id]/resolve/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(401);
    expect(alertFindFirst).not.toHaveBeenCalled();
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('returns opaque 404 when an admin has no active member in the selected workspace', async () => {
    requireAlertWorkspaceMemberMock.mockRejectedValueOnce(
      Response.json({ error: 'not_found' }, { status: 404 }),
    );
    const { POST } = await import('@/app/api/alerts/[id]/resolve/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(alertFindFirst).not.toHaveBeenCalled();
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('returns 400 when the body is malformed JSON', async () => {
    const req = new Request('http://test/api/alerts/alert-1/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    const { POST } = await import('@/app/api/alerts/[id]/resolve/route');
    const res = await POST(req, {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(400);
    expect(alertFindFirst).not.toHaveBeenCalled();
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('returns 400 when the note is >500 chars (zod max)', async () => {
    const { POST } = await import('@/app/api/alerts/[id]/resolve/route');
    const res = await POST(makePostRequest({ note: 'x'.repeat(501) }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(400);
    expect(alertFindFirst).not.toHaveBeenCalled();
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('returns 400 when an undisclosed field is included (.strict())', async () => {
    const { POST } = await import('@/app/api/alerts/[id]/resolve/route');
    const res = await POST(makePostRequest({ note: 'ok', evilField: 'extra' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(400);
    expect(alertFindFirst).not.toHaveBeenCalled();
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('returns opaque 404 when the alert belongs to a different team', async () => {
    alertFindFirst.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/alerts/[id]/resolve/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'not_found' });
    expect(alertFindFirst.mock.calls[0]?.[0].where).toEqual({
      id: 'alert-1',
      teamId: 'team-1',
    });
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('returns 200 + envelope on idempotent re-resolve without firing an UPDATE', async () => {
    alertFindFirst.mockResolvedValueOnce(makeResolvedRow());
    const { POST } = await import('@/app/api/alerts/[id]/resolve/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      id: 'alert-1',
      status: 'resolved',
      statusChangedAt: RESOLVED_AT.toISOString(),
      acknowledgedAt: new Date('2026-06-30T08:30:00Z').toISOString(),
      closedAt: RESOLVED_AT.toISOString(),
      closedBy: 'user-1',
      closingNote: 'Closed in scope',
      reopenedAt: null,
      reopenedBy: null,
      reopenReason: null,
    });
    // The idempotent branch reads the row but skips the prisma.write —
    // a re-click MUST NOT churn the column with a fresh timestamp.
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('does NOT overwrite closedAt/closedBy on a no-body re-resolve (empty-body branch fires no write)', async () => {
    // The empty-body branch on the already-resolved path is a true
    // no-op — it neither fires an UPDATE nor churns the trio. Asserted
    // by reading the envelope and confirming no UPDATE fired.
    alertFindFirst.mockResolvedValueOnce(
      makeResolvedRow({
        closedAt: new Date('2026-07-01T12:00:00Z'),
        closedBy: 'user-original',
        closingNote: 'original note',
      }),
    );
    const { POST } = await import('@/app/api/alerts/[id]/resolve/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    expect(alertUpdate).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.closedAt).toBe(new Date('2026-07-01T12:00:00Z').toISOString());
    expect(body.closedBy).toBe('user-original');
    expect(body.closingNote).toBe('original note');
  });

  it('on re-resolve with a fresh note: UPDATE fires for closingNote + statusChangedAt only', async () => {
    // Partial update — closingNote + statusChangedAt, NOT closedAt /
    // closedBy. closedAt / closedBy encode first-write identity.
    alertFindFirst.mockResolvedValueOnce(
      makeResolvedRow({
        closedAt: new Date('2026-07-01T12:00:00.000Z'),
        closedBy: 'user-original',
        closingNote: 'old note',
      }),
    );
    const REFRESH_STAMP = new Date('2026-07-03T08:00:00Z');
    alertUpdate.mockResolvedValueOnce({
      id: 'alert-1',
      teamId: 'team-1',
      status: 'resolved',
      statusChangedAt: REFRESH_STAMP,
      acknowledgedAt: null,
      closedAt: new Date('2026-07-01T12:00:00.000Z'),
      closedBy: 'user-original',
      closingNote: 'fresh note',
    });
    const { POST } = await import('@/app/api/alerts/[id]/resolve/route');
    const res = await POST(makePostRequest({ note: 'fresh note' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    expect(alertUpdate).toHaveBeenCalledTimes(1);
    const call = alertUpdate.mock.calls[0]?.[0];
    expect(call.where).toEqual({ id: 'alert-1' });
    expect(call.data.statusChangedAt).toBeInstanceOf(Date);
    expect(call.data.closingNote).toBe('fresh note');
    // closedAt / closedBy are NOT overwritten on the re-resolve path.
    expect(call.data).not.toHaveProperty('closedAt');
    expect(call.data).not.toHaveProperty('closedBy');
    expect(call.data).not.toHaveProperty('status');
    const body = await res.json();
    expect(body.closedAt).toBe(new Date('2026-07-01T12:00:00.000Z').toISOString());
    expect(body.closedBy).toBe('user-original');
    expect(body.closingNote).toBe('fresh note');
    expect(body.statusChangedAt).toBe(REFRESH_STAMP.toISOString());
  });

  it('on re-resolve with whitespace-only note: omitted key path, no UPDATE fires', async () => {
    // A whitespace-only note is treated as empty on the client (after
    // `closingNote.trim()`); the body it sends is `{}` so the route
    // takes the "no body — no write" idempotent branch.
    alertFindFirst.mockResolvedValueOnce(makeResolvedRow());
    const { POST } = await import('@/app/api/alerts/[id]/resolve/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('transitions an open row to resolved and stamps statusChangedAt + close-stamp trio (no note)', async () => {
    alertFindFirst.mockResolvedValueOnce(makeOpenRow());
    // No body sent — closingNote must be null on the write (the
    // route stamps `closingNote: null` when the body is empty).
    alertUpdate.mockResolvedValueOnce(makeResolvedUpdatedRow({ closingNote: null }));
    const { POST } = await import('@/app/api/alerts/[id]/resolve/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    expect(alertUpdate).toHaveBeenCalledTimes(1);
    const call = alertUpdate.mock.calls[0]?.[0];
    expect(call.where).toEqual({ id: 'alert-1' });
    expect(call.data.status).toBe('resolved');
    expect(call.data.statusChangedAt).toBeInstanceOf(Date);
    // The close-stamp trio is written on the same write — even when
    // no note is provided, server-stamps `closedAt` + `closedBy`.
    expect(call.data.closedAt).toBeInstanceOf(Date);
    expect(call.data.closedBy).toBe('user-1');
    expect(call.data.closingNote).toBeNull();
    const body = await res.json();
    expect(body.status).toBe('resolved');
    expect(body.statusChangedAt).toBe(RESOLVED_AT.toISOString());
    expect(body.acknowledgedAt).toBeNull();
    expect(body.closedAt).toBe(RESOLVED_AT.toISOString());
    expect(body.closedBy).toBe('user-1');
    expect(body.closingNote).toBeNull();
  });

  it('with-note: stamps closingNote on the same write as status → resolved', async () => {
    alertFindFirst.mockResolvedValueOnce(makeOpenRow());
    alertUpdate.mockResolvedValueOnce(
      makeResolvedUpdatedRow({ closingNote: 'Fixed via WAF rule' }),
    );
    const { POST } = await import('@/app/api/alerts/[id]/resolve/route');
    const res = await POST(makePostRequest({ note: 'Fixed via WAF rule' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    const call = alertUpdate.mock.calls[0]?.[0];
    expect(call.data.status).toBe('resolved');
    expect(call.data.closingNote).toBe('Fixed via WAF rule');
    expect(call.data.closedAt).toBeInstanceOf(Date);
    expect(call.data.closedBy).toBe('user-1');
    const body = await res.json();
    expect(body.closingNote).toBe('Fixed via WAF rule');
    expect(body.closedAt).toBe(RESOLVED_AT.toISOString());
    expect(body.closedBy).toBe('user-1');
  });

  it('transitions an in_progress row to resolved', async () => {
    alertFindFirst.mockResolvedValueOnce(makeOpenRow({ status: 'in_progress' }));
    alertUpdate.mockResolvedValueOnce(makeResolvedUpdatedRow());
    const { POST } = await import('@/app/api/alerts/[id]/resolve/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    expect(alertUpdate).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.status).toBe('resolved');
  });

  it('returns 404 if the UPDATE somehow yields a cross-team row (defence-in-depth)', async () => {
    alertFindFirst.mockResolvedValueOnce(makeOpenRow());
    // Simulate a stale or compromised write landing on a different
    // team's row even though findFirst returned our team — the
    // second `teamId` check catches it.
    alertUpdate.mockResolvedValueOnce({
      id: 'alert-1',
      teamId: 'team-OTHER',
      status: 'resolved',
      statusChangedAt: RESOLVED_AT,
      acknowledgedAt: null,
      closedAt: RESOLVED_AT,
      closedBy: 'user-1',
      closingNote: null,
    });
    const { POST } = await import('@/app/api/alerts/[id]/resolve/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'not_found' });
  });

  it('returns 500 when the DB throws on the scope-check', async () => {
    alertFindFirst.mockRejectedValueOnce(new Error('db down'));
    const { POST } = await import('@/app/api/alerts/[id]/resolve/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(500);
  });

  it('returns 500 when the UPDATE throws', async () => {
    alertFindFirst.mockResolvedValueOnce(makeOpenRow());
    alertUpdate.mockRejectedValueOnce(new Error('write failed'));
    const { POST } = await import('@/app/api/alerts/[id]/resolve/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(500);
  });
});

// ===================== First-write dispatch hook =====================

describe('POST /api/alerts/[id]/resolve — alert-resolved dispatch', () => {
  it('fires alertResolvedEmail to owner + watchers on the FIRST-write transition', async () => {
    // Scope check (status: 'open') → update resolves → dispatch peer-read.
    alertFindFirst.mockResolvedValueOnce(makeOpenRow());
    alertUpdate.mockResolvedValueOnce(makeResolvedUpdatedRow({ closingNote: 'WAF rule shipped' }));
    // Dispatch peer-read — owned alert, severity high, host visible.
    alertFindFirst.mockResolvedValueOnce({
      id: 'alert-1',
      ownerId: 'wm-owner',
      severity: 'high',
      finding: { asset: { host: 'edge.example.com' } },
    });
    // Caller ISN'T the owner — callerWorkspaceMember 'mem-1' ≠ 'wm-owner'.
    workspaceMemberFindFirst
      .mockResolvedValueOnce({ id: 'mem-1' })
      .mockResolvedValueOnce({ id: 'wm-owner', userId: 'user-owner' });
    // Resolver email (user-1 → member@example.com) and owner email.
    // The mock fn returns the first arg's `where.id` to disambiguate.
    userFindUnique
      .mockResolvedValueOnce({ email: 'member@example.com' })
      .mockResolvedValueOnce({ email: 'owner@example.com' });
    // AlertNote distinct-watchers batch: 2 unique authors, neither is
    // the resolver. Including a duplicate row to prove `.distinct`
    // collapses on the way through (returned as 2 rows post-distinct).
    alertNoteFindMany.mockResolvedValueOnce([
      { authorUserId: 'user-2' },
      { authorUserId: 'user-3' },
      { authorUserId: 'user-2' },
    ]);
    // Watcher emails batch (user.findMany where id IN [user-2, user-3])
    userFindMany.mockResolvedValueOnce([
      { id: 'user-2', email: 'watcher2@example.com' },
      { id: 'user-3', email: 'watcher3@example.com' },
    ]);
    sendEmailMock.mockResolvedValue({ id: 'msg-1' });
    const { POST } = await import('@/app/api/alerts/[id]/resolve/route');
    const res = await POST(makePostRequest({ note: 'WAF rule shipped' }, 'alert-1'), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    // Resolver excluded from the recipients set; owner + 2 watchers
    // dedup into a single 3-recipient fan-out with NO duplicate keys.
    const recipients = sendEmailMock.mock.calls.map((c) => (c[0] as { to: string }).to);
    expect(recipients).toEqual([
      'owner@example.com',
      'watcher2@example.com',
      'watcher3@example.com',
    ]);
    // Subject + ctaUrl + body shape — content carried by the template
    // (asserted here so a wired-through wiring regression crashes
    // loudly instead of emitting a no-subject email).
    const firstCall = sendEmailMock.mock.calls[0]?.[0] as {
      subject: string;
      html: string;
      text?: string;
    };
    expect(firstCall.subject).toBe('Your alert on edge.example.com was resolved');
    expect(firstCall.html).toMatch(/edge\.example\.com/);
    expect(firstCall.html).toContain('Severity: high.');
    expect(firstCall.html).toContain('Resolve note: WAF rule shipped');
    expect(firstCall.html).toContain('https://test.example.com/alerts/alert-1');
  });

  it('skips email when the alert has no owner (unowned resolve still succeeds)', async () => {
    alertFindFirst.mockResolvedValueOnce(makeOpenRow());
    alertUpdate.mockResolvedValueOnce(makeResolvedUpdatedRow());
    // Dispatch peer-read returns ownerId: null → entire dispatch hook
    // is skipped (no WorkspaceMember/User reads, no sendEmail call).
    alertFindFirst.mockResolvedValueOnce({
      id: 'alert-1',
      ownerId: null,
      severity: 'medium',
      finding: { asset: { host: 'edge.example.com' } },
    });
    const { POST } = await import('@/app/api/alerts/[id]/resolve/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(workspaceMemberFindFirst).not.toHaveBeenCalled();
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it('skips email when the resolver IS the owner', async () => {
    alertFindFirst.mockResolvedValueOnce(makeOpenRow());
    alertUpdate.mockResolvedValueOnce(makeResolvedUpdatedRow());
    alertFindFirst.mockResolvedValueOnce({
      id: 'alert-1',
      ownerId: 'mem-1',
      severity: 'low',
      finding: { asset: { host: 'edge.example.com' } },
    });
    // callerWorkspaceMember.id === ownerId (both 'mem-1') → self-resolve.
    workspaceMemberFindFirst.mockResolvedValueOnce({ id: 'mem-1' });
    const { POST } = await import('@/app/api/alerts/[id]/resolve/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    expect(sendEmailMock).not.toHaveBeenCalled();
    // Owner WorkspaceMember pivot is NEVER read on self-resolve — the
    // guard short-circuits before the second workspaceMember.findFirst.
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it('a proxy throw on one recipient does not break the resolve envelope', async () => {
    alertFindFirst.mockResolvedValueOnce(makeOpenRow());
    alertUpdate.mockResolvedValueOnce(makeResolvedUpdatedRow());
    alertFindFirst.mockResolvedValueOnce({
      id: 'alert-1',
      ownerId: 'wm-owner',
      severity: 'critical',
      finding: { asset: { host: 'edge.example.com' } },
    });
    workspaceMemberFindFirst
      .mockResolvedValueOnce({ id: 'mem-1' })
      .mockResolvedValueOnce({ id: 'wm-owner', userId: 'user-owner' });
    userFindUnique
      .mockResolvedValueOnce({ email: 'member@example.com' })
      .mockResolvedValueOnce({ email: 'owner@example.com' });
    alertNoteFindMany.mockResolvedValueOnce([]);
    userFindMany.mockResolvedValueOnce([]);
    // First (and only) sendEmail rejects — fire-and-forget `.catch`
    // swallows so the persisted envelope still 2xx's.
    sendEmailMock.mockRejectedValueOnce(new Error('proxy throttled'));
    const { POST } = await import('@/app/api/alerts/[id]/resolve/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('resolved');
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('no email on a no-body re-resolve (idempotent, no write)', async () => {
    // Re-resolve on already-resolved + empty body → empty-body branch
    // fires no UPDATE and never enters the dispatch hook.
    alertFindFirst.mockResolvedValueOnce(makeResolvedRow());
    const { POST } = await import('@/app/api/alerts/[id]/resolve/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    expect(alertUpdate).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

// ===================== Method guards =====================

describe('methodNotAllowed stubs for /api/alerts/[id]/resolve', () => {
  it.each([['GET'], ['PUT'], ['PATCH'], ['DELETE']])(
    '%s returns 405 with Allow: POST',
    async (method) => {
      const routeModule = await import('@/app/api/alerts/[id]/resolve/route');
      const handler = (routeModule as unknown as Record<string, () => Promise<Response>>)[method];
      const res = await handler();
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('POST');
    },
  );
});
