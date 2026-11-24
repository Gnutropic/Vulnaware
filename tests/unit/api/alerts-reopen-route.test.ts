// @vitest-environment node
// Unit tests for POST /api/alerts/[id]/reopen. Posture mirrors
// tests/unit/api/alerts-resolve-route.test.ts:
//   - vi.mock('server-only') so the module loads
//   - vi.mock('@/lib/db') exposing the prisma.alert.{findFirst,update}
//     surface the route touches
//   - vi.mock('@/lib/team-auth') with a swappable requireTeamRole whose
//     thrown Response encodes the 401/403 gates
//
// Mirror of the resolve test surface, with the polarity flipped:
//   - 401 anon, 403 below-member — opaque, body untouched by the route's
//     parse step
//   - 404 opaque cross-team (no UPDATE fired)
//   - 200 idempotent re-open: existing status: 'open' returns the same
//     envelope without a prisma.write — a stale click MUST NOT churn
//     statusChangedAt down to the latest click timestamp.
//   - 200 transition from 'resolved' (or 'in_progress' or
//     'false_positive') → 'open' flips status + statusChangedAt +
//     CLEARS the falsePositiveReason so an FP row that gets re-opened
//     doesn't carry the suppression stamp forward.
//   - 500 on DB throw
//   - GET/PUT/PATCH/DELETE → 405 with Allow: POST

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const alertFindFirst = vi.fn();
const alertUpdate = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    alert: {
      findFirst: alertFindFirst,
      update: alertUpdate,
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

function makePostRequest(body: unknown = {}, id = 'alert-1') {
  return new Request(`http://test/api/alerts/${id}/reopen`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeResolvedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-1',
    teamId: 'team-1',
    status: 'resolved',
    statusChangedAt: new Date('2026-07-01T12:00:00Z'),
    acknowledgedAt: new Date('2026-06-30T08:30:00Z'),
    falsePositiveReason: null,
    closedAt: new Date('2026-07-01T12:00:00Z'),
    closedBy: 'user-1',
    closingNote: null,
    reopenedAt: null,
    reopenedBy: null,
    reopenReason: null,
    ...overrides,
  };
}

function makeOpenRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-1',
    teamId: 'team-1',
    status: 'open',
    statusChangedAt: REOPEN_AT,
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

function makeFalsePositiveRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-1',
    teamId: 'team-1',
    status: 'false_positive',
    statusChangedAt: new Date('2026-07-01T11:00:00Z'),
    acknowledgedAt: null,
    falsePositiveReason: 'scanner mis-flagged',
    closedAt: null,
    closedBy: null,
    closingNote: null,
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

// ===================== POST /api/alerts/[id]/reopen =====================

describe('POST /api/alerts/[id]/reopen', () => {
  it('returns 401 when there is no session', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Unauthorized' }, { status: 401 });
    });
    const { POST } = await import('@/app/api/alerts/[id]/reopen/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(401);
    expect(alertFindFirst).not.toHaveBeenCalled();
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('returns 403 when caller is below member', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Forbidden' }, { status: 403 });
    });
    const { POST } = await import('@/app/api/alerts/[id]/reopen/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(403);
    expect(alertFindFirst).not.toHaveBeenCalled();
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('returns opaque 404 when the alert belongs to a different team', async () => {
    alertFindFirst.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/alerts/[id]/reopen/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'not_found' });
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('returns 200 + envelope on idempotent re-open without firing an UPDATE', async () => {
    alertFindFirst.mockResolvedValueOnce(makeOpenRow());
    const { POST } = await import('@/app/api/alerts/[id]/reopen/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // The widened AlertResolveResponse includes the close-stamp trio
    // echoing the (typically null) values on the open row. `closedAt`
    // / `closedBy` / `closingNote` are all null because every prior
    // reopen write cleared them. The reopen trio rides alongside —
    // null on a row that has yet to be reopened so the envelope
    // mirrors the row's prior state to the event loop.
    expect(body).toEqual({
      id: 'alert-1',
      status: 'open',
      statusChangedAt: REOPEN_AT.toISOString(),
      acknowledgedAt: null,
      closedAt: null,
      closedBy: null,
      closingNote: null,
      reopenedAt: null,
      reopenedBy: null,
      reopenReason: null,
    });
    // The idempotent branch reads the row but skips the prisma.write —
    // a stale click MUST NOT churn the column with a fresh timestamp.
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('transitions a resolved row to open and stamps statusChangedAt', async () => {
    alertFindFirst.mockResolvedValueOnce(makeResolvedRow());
    alertUpdate.mockResolvedValueOnce({
      id: 'alert-1',
      teamId: 'team-1',
      status: 'open',
      statusChangedAt: REOPEN_AT,
      acknowledgedAt: null,
      falsePositiveReason: null,
      closedAt: null,
      closedBy: null,
      closingNote: null,
    });
    const { POST } = await import('@/app/api/alerts/[id]/reopen/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    // scope gate fires BEFORE the write; the UPDATE itself targets
    // `id` (Alert.id is the primary key — `(id, teamId)` is not
    // unique-keyable on Prisma update); post-write teamId verify
    // guards against a stale token flipping across teams.
    expect(alertUpdate).toHaveBeenCalledTimes(1);
    const call = alertUpdate.mock.calls[0]?.[0];
    expect(call.where).toEqual({ id: 'alert-1' });
    // Resolved rows are reopened by clearing the close-stamp trio
    // alongside statusChangedAt + falsePositiveReason — the same
    // write that flips status → 'open' MUST land all four operator-
    // stamp columns (status, statusChangedAt, falsePositiveReason,
    // and the close trio) in lockstep so a triage flip never carries
    // either stamp forward.
    expect(call.data).toEqual(
      expect.objectContaining({
        status: 'open',
        statusChangedAt: expect.any(Date),
        falsePositiveReason: null,
        closedAt: null,
        closedBy: null,
        closingNote: null,
      }),
    );
    const body = await res.json();
    expect(body.status).toBe('open');
    expect(body.statusChangedAt).toBe(REOPEN_AT.toISOString());
    expect(body.closedAt).toBeNull();
    expect(body.closedBy).toBeNull();
    expect(body.closingNote).toBeNull();
  });

  it('transitions a false_positive row back to open and CLEARS the reason', async () => {
    // Re-opening a FP row is the route's idempotent-already-state
    // inverse: the suppression stamp must NOT ride the triage flip
    // forward. The update writes falsePositiveReason: null so the
    // post-flip row can never surface in `?status=open` carrying the
    // stale reason.
    alertFindFirst.mockResolvedValueOnce(makeFalsePositiveRow());
    alertUpdate.mockResolvedValueOnce({
      id: 'alert-1',
      teamId: 'team-1',
      status: 'open',
      statusChangedAt: REOPEN_AT,
      acknowledgedAt: null,
      falsePositiveReason: null,
      closedAt: null,
      closedBy: null,
      closingNote: null,
    });
    const { POST } = await import('@/app/api/alerts/[id]/reopen/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    expect(alertUpdate).toHaveBeenCalledTimes(1);
    const call = alertUpdate.mock.calls[0]?.[0];
    expect(call.data).toEqual(
      expect.objectContaining({
        status: 'open',
        falsePositiveReason: null,
        closedAt: null,
        closedBy: null,
        closingNote: null,
        statusChangedAt: expect.any(Date),
      }),
    );
    const body = await res.json();
    expect(body.status).toBe('open');
    expect(body.closingNote).toBeNull();
  });

  it('returns 404 if the UPDATE somehow yields a cross-team row (defence-in-depth)', async () => {
    alertFindFirst.mockResolvedValueOnce(makeResolvedRow());
    // Simulate a stale or compromised write landing on a different
    // team's row even though findFirst returned our team — the
    // second `teamId` check catches it.
    alertUpdate.mockResolvedValueOnce({
      id: 'alert-1',
      teamId: 'team-OTHER',
      status: 'open',
      statusChangedAt: REOPEN_AT,
      acknowledgedAt: null,
      falsePositiveReason: null,
    });
    const { POST } = await import('@/app/api/alerts/[id]/reopen/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'not_found' });
  });

  it('returns 500 when the DB throws on the scope-check', async () => {
    alertFindFirst.mockRejectedValueOnce(new Error('db down'));
    const { POST } = await import('@/app/api/alerts/[id]/reopen/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(500);
  });

  it('returns 500 when the UPDATE throws', async () => {
    alertFindFirst.mockResolvedValueOnce(makeResolvedRow());
    alertUpdate.mockRejectedValueOnce(new Error('write failed'));
    const { POST } = await import('@/app/api/alerts/[id]/reopen/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(500);
  });

  // ===================== Body validation =====================

  it('stamps a non-empty trimmed `reason` onto reopenReason on the same write', async () => {
    // The reopen body is OPTIONAL, but a non-empty trimmed value
    // lands on the same write that flips status → 'open' (mirrors
    // the resolve route's closingNote posture).
    alertFindFirst.mockResolvedValueOnce(makeResolvedRow());
    alertUpdate.mockResolvedValueOnce({
      id: 'alert-1',
      teamId: 'team-1',
      status: 'open',
      statusChangedAt: REOPEN_AT,
      acknowledgedAt: null,
      falsePositiveReason: null,
      closedAt: null,
      closedBy: null,
      closingNote: null,
      reopenedAt: REOPEN_AT,
      reopenedBy: 'user-1',
      reopenReason: 'short reason',
    });
    const req = new Request('http://test/api/alerts/alert-1/reopen', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'short reason' }),
    });
    const { POST } = await import('@/app/api/alerts/[id]/reopen/route');
    const res = await POST(req, {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    expect(alertUpdate).toHaveBeenCalledTimes(1);
    const call = alertUpdate.mock.calls[0]?.[0];
    // The trimmed reason rides the same UPDATE — the route stamps
    // `reopenReason: 'short reason'` so the parsed-envelope echo
    // surfaces the same value to the operator.
    expect(call.data).toEqual(
      expect.objectContaining({
        status: 'open',
        falsePositiveReason: null,
        closingNote: null,
        reopenReason: 'short reason',
        reopenedBy: 'user-1',
        statusChangedAt: expect.any(Date),
        reopenedAt: expect.any(Date),
      }),
    );
    const body = await res.json();
    expect(body.reopenReason).toBe('short reason');
    expect(body.reopenedBy).toBe('user-1');
    expect(body.reopenedAt).toBe(REOPEN_AT.toISOString());
  });

  it('collapses a whitespace-only `reason` to reopenReason: null on disk', async () => {
    // Whitespace-only input is treated as empty on the client after
    // `.trim()`; the body sends a post-trim empty string, which the
    // route normalizes to `reopenReason: null` so the row column
    // never carries an invisible empty string.
    alertFindFirst.mockResolvedValueOnce(makeResolvedRow());
    alertUpdate.mockResolvedValueOnce({
      id: 'alert-1',
      teamId: 'team-1',
      status: 'open',
      statusChangedAt: REOPEN_AT,
      acknowledgedAt: null,
      falsePositiveReason: null,
      closedAt: null,
      closedBy: null,
      closingNote: null,
      reopenedAt: REOPEN_AT,
      reopenedBy: 'user-1',
      reopenReason: null,
    });
    const req = new Request('http://test/api/alerts/alert-1/reopen', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: '   ' }),
    });
    const { POST } = await import('@/app/api/alerts/[id]/reopen/route');
    const res = await POST(req, {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    expect(alertUpdate).toHaveBeenCalledTimes(1);
    const call = alertUpdate.mock.calls[0]?.[0];
    expect(call.data.reopenReason).toBeNull();
    const body = await res.json();
    expect(body.reopenReason).toBeNull();
  });

  it('preserves a 500-char `reason` verbatim (DB-side VARCHAR(500) ceiling)', async () => {
    // The zod schema enforces `max(500)`; the string sent below is
    // exactly 500 chars (no off-by-one) so the route accepts it and
    // writes the trimmed value verbatim.
    const REASON_500 = 'a'.repeat(500);
    alertFindFirst.mockResolvedValueOnce(makeResolvedRow());
    alertUpdate.mockResolvedValueOnce({
      id: 'alert-1',
      teamId: 'team-1',
      status: 'open',
      statusChangedAt: REOPEN_AT,
      acknowledgedAt: null,
      falsePositiveReason: null,
      closedAt: null,
      closedBy: null,
      closingNote: null,
      reopenedAt: REOPEN_AT,
      reopenedBy: 'user-1',
      reopenReason: REASON_500,
    });
    const req = new Request('http://test/api/alerts/alert-1/reopen', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: ` ${REASON_500} ` }),
    });
    const { POST } = await import('@/app/api/alerts/[id]/reopen/route');
    const res = await POST(req, {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    expect(alertUpdate).toHaveBeenCalledTimes(1);
    const call = alertUpdate.mock.calls[0]?.[0];
    // Trimmed — leading/trailing whitespace stripped — so the
    // stored reason equals the 500-char string verbatim.
    expect(call.data.reopenReason).toBe(REASON_500);
  });

  it('returns 400 when `reason` exceeds 500 chars (zod max)', async () => {
    // Cap enforcement happens before the DB read so a malformed
    // client that tries to lift past the VARCHAR(500) ceiling
    // hits an immediate 400 rather than a 500 from the INSERT.
    const { POST } = await import('@/app/api/alerts/[id]/reopen/route');
    const res = await POST(makePostRequest({ reason: 'x'.repeat(501) }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(400);
    expect(alertFindFirst).not.toHaveBeenCalled();
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('returns 400 when an undisclosed field is included (.strict())', async () => {
    // `.strict()` keeps drift contained — a future caller field
    // 400s through rather than silently accepting arbitrary keys.
    const { POST } = await import('@/app/api/alerts/[id]/reopen/route');
    const res = await POST(makePostRequest({ reason: 'ok', evilField: 'extra' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(400);
    expect(alertFindFirst).not.toHaveBeenCalled();
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('returns 400 when the body is malformed JSON', async () => {
    const req = new Request('http://test/api/alerts/alert-1/reopen', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    const { POST } = await import('@/app/api/alerts/[id]/reopen/route');
    const res = await POST(req, {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(400);
    expect(alertFindFirst).not.toHaveBeenCalled();
    expect(alertUpdate).not.toHaveBeenCalled();
  });
});

// ===================== Method guards =====================

describe('methodNotAllowed stubs for /api/alerts/[id]/reopen', () => {
  it.each([['GET'], ['PUT'], ['PATCH'], ['DELETE']])(
    '%s returns 405 with Allow: POST',
    async (method) => {
      const routeModule = await import('@/app/api/alerts/[id]/reopen/route');
      const handler = (routeModule as unknown as Record<string, () => Promise<Response>>)[method];
      const res = await handler();
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('POST');
    },
  );
});
