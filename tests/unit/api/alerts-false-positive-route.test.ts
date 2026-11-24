// @vitest-environment node
// Unit tests for POST /api/alerts/[id]/false-positive. Posture mirrors
// tests/unit/api/alerts-resolve-route.test.ts:
//   - vi.mock('server-only') so the module loads
//   - vi.mock('@/lib/db') exposing the prisma.alert.{findFirst,update}
//     surface the route touches
//   - vi.mock('@/lib/team-auth') with a swappable requireTeamRole whose
//     thrown Response encodes the 401/403 gates
//   - vi.mock('next/server') translation of methodNotAllowed() to 405
//
// Asserted:
//   - 401 anon / 403 below-member — opaque Response surfaced
//   - 400 empty / whitespace / >500-char / non-string / missing reason
//     body — zod schema parses body BEFORE the scope gate (server-side
//     reality for client-side maxLength mirror)
//   - 404 cross-team — opaque before any UPDATE fires
//   - 200 idempotent re-stamp on already-FP row: findFirst returns
//     `{ status: 'false_positive', falsePositiveReason: '...' }`;
//     no update fires; envelope round-trips with the previous
//     reason + timestamps
//   - 200 transition from open|in_progress|resolved → false_positive
//     updates status + statusChangedAt + falsePositiveReason; defense-
//     in-depth teamId check still fires on a cross-team shadow write
//   - 500 on DB throw (findFirst OR update)
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

const STAMP_AT = new Date('2026-07-01T12:00:00Z');

function makePostRequest(body: unknown = { reason: 'scanner mis-flagged' }, id = 'alert-1') {
  return new Request(`http://test/api/alerts/${id}/false-positive`, {
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
    ...overrides,
  };
}

function makeFalsePositiveRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-1',
    teamId: 'team-1',
    status: 'false_positive',
    statusChangedAt: STAMP_AT,
    acknowledgedAt: null,
    falsePositiveReason: 'scanner mis-flagged',
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

// ===================== POST /api/alerts/[id]/false-positive =====================

describe('POST /api/alerts/[id]/false-positive', () => {
  it('returns 401 when there is no session', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Unauthorized' }, { status: 401 });
    });
    const { POST } = await import('@/app/api/alerts/[id]/false-positive/route');
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
    const { POST } = await import('@/app/api/alerts/[id]/false-positive/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(403);
    expect(alertFindFirst).not.toHaveBeenCalled();
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('returns 400 with issues when the reason body is missing', async () => {
    const { POST } = await import('@/app/api/alerts/[id]/false-positive/route');
    const res = await POST(makePostRequest({}), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('bad_request');
    expect(body.issues).toBeDefined();
    expect(alertFindFirst).not.toHaveBeenCalled();
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('returns 400 when the reason is an empty string', async () => {
    const { POST } = await import('@/app/api/alerts/[id]/false-positive/route');
    const res = await POST(makePostRequest({ reason: '' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(400);
    expect(alertFindFirst).not.toHaveBeenCalled();
  });

  it('returns 400 when the reason is whitespace-only (.trim() makes min(1) fail)', async () => {
    const { POST } = await import('@/app/api/alerts/[id]/false-positive/route');
    const res = await POST(makePostRequest({ reason: '   ' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(400);
    expect(alertFindFirst).not.toHaveBeenCalled();
  });

  it('returns 400 when the reason is >500 chars (zod max, before VARCHAR DB cap)', async () => {
    const { POST } = await import('@/app/api/alerts/[id]/false-positive/route');
    const res = await POST(makePostRequest({ reason: 'x'.repeat(501) }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(400);
    expect(alertFindFirst).not.toHaveBeenCalled();
  });

  it('returns 400 when the JSON body is malformed', async () => {
    const req = new Request('http://test/api/alerts/alert-1/false-positive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    const { POST } = await import('@/app/api/alerts/[id]/false-positive/route');
    const res = await POST(req, {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when an undisclosed field is included (.strict())', async () => {
    const { POST } = await import('@/app/api/alerts/[id]/false-positive/route');
    const res = await POST(makePostRequest({ reason: 'ok', evilField: 'extra' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(400);
    expect(alertFindFirst).not.toHaveBeenCalled();
  });

  it('returns opaque 404 when the alert belongs to a different team', async () => {
    alertFindFirst.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/alerts/[id]/false-positive/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'not_found' });
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('returns 200 + envelope on idempotent re-stamp without firing an UPDATE', async () => {
    alertFindFirst.mockResolvedValueOnce(makeFalsePositiveRow());
    const { POST } = await import('@/app/api/alerts/[id]/false-positive/route');
    const res = await POST(makePostRequest({ reason: 'scanner mis-flagged' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('alert-1');
    expect(body.status).toBe('false_positive');
    expect(body.statusChangedAt).toBe(STAMP_AT.toISOString());
    expect(body.acknowledgedAt).toBeNull();
    expect(body.falsePositiveReason).toBe('scanner mis-flagged');
    // Idempotent branch reads the row but skips the prisma.write —
    // a re-click MUST NOT churn statusChangedAt with a fresh stamp.
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('returns the existing envelope unchanged when called with a different reason on an already-FP row', async () => {
    // The route's idempotent branch fires strictly on status, NOT
    // on the reason. Reason overwrites would need a separate branch
    // (and the UI hides the FP button on already-FP rows so this
    // case is unreachable in practice), but the route still
    // ratifies the no-rewrite posture so a future caller never
    // mysteriously stamps a different reason in the DB without an
    // explicit transition.
    alertFindFirst.mockResolvedValueOnce(
      makeFalsePositiveRow({ falsePositiveReason: 'old reason' }),
    );
    const { POST } = await import('@/app/api/alerts/[id]/false-positive/route');
    const res = await POST(makePostRequest({ reason: 'new reason' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    expect(alertUpdate).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.falsePositiveReason).toBe('old reason');
  });

  it('transitions an open row to false_positive and stamps statusChangedAt + reason', async () => {
    alertFindFirst.mockResolvedValueOnce(makeOpenRow());
    alertUpdate.mockResolvedValueOnce({
      id: 'alert-1',
      teamId: 'team-1',
      status: 'false_positive',
      statusChangedAt: STAMP_AT,
      acknowledgedAt: null,
      falsePositiveReason: 'scanner mis-flagged',
    });
    const { POST } = await import('@/app/api/alerts/[id]/false-positive/route');
    const res = await POST(makePostRequest({ reason: 'scanner mis-flagged' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    expect(alertUpdate).toHaveBeenCalledTimes(1);
    const call = alertUpdate.mock.calls[0]?.[0];
    expect(call.where).toEqual({ id: 'alert-1' });
    expect(call.data.status).toBe('false_positive');
    expect(call.data.falsePositiveReason).toBe('scanner mis-flagged');
    expect(call.data.statusChangedAt).toBeInstanceOf(Date);
    const body = await res.json();
    expect(body.status).toBe('false_positive');
    expect(body.statusChangedAt).toBe(STAMP_AT.toISOString());
    expect(body.falsePositiveReason).toBe('scanner mis-flagged');
  });

  it('transitions an in_progress row to false_positive', async () => {
    alertFindFirst.mockResolvedValueOnce(makeOpenRow({ status: 'in_progress' }));
    alertUpdate.mockResolvedValueOnce({
      id: 'alert-1',
      teamId: 'team-1',
      status: 'false_positive',
      statusChangedAt: STAMP_AT,
      acknowledgedAt: null,
      falsePositiveReason: 'in-scope',
    });
    const { POST } = await import('@/app/api/alerts/[id]/false-positive/route');
    const res = await POST(makePostRequest({ reason: 'in-scope' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    expect(alertUpdate).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.status).toBe('false_positive');
  });

  it('transitions a resolved row to false_positive', async () => {
    alertFindFirst.mockResolvedValueOnce(makeOpenRow({ status: 'resolved' }));
    alertUpdate.mockResolvedValueOnce({
      id: 'alert-1',
      teamId: 'team-1',
      status: 'false_positive',
      statusChangedAt: STAMP_AT,
      acknowledgedAt: null,
      falsePositiveReason: 'was wrongly resolved',
    });
    const { POST } = await import('@/app/api/alerts/[id]/false-positive/route');
    const res = await POST(makePostRequest({ reason: 'was wrongly resolved' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    expect(alertUpdate).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.status).toBe('false_positive');
  });

  it('returns 404 if the UPDATE yields a cross-team row (defence-in-depth)', async () => {
    alertFindFirst.mockResolvedValueOnce(makeOpenRow());
    alertUpdate.mockResolvedValueOnce({
      id: 'alert-1',
      teamId: 'team-OTHER',
      status: 'false_positive',
      statusChangedAt: STAMP_AT,
      acknowledgedAt: null,
      falsePositiveReason: 'whatever',
    });
    const { POST } = await import('@/app/api/alerts/[id]/false-positive/route');
    const res = await POST(makePostRequest({ reason: 'whatever' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'not_found' });
  });

  it('returns 500 when the DB throws on the scope-check', async () => {
    alertFindFirst.mockRejectedValueOnce(new Error('db down'));
    const { POST } = await import('@/app/api/alerts/[id]/false-positive/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(500);
  });

  it('returns 500 when the UPDATE throws', async () => {
    alertFindFirst.mockResolvedValueOnce(makeOpenRow());
    alertUpdate.mockRejectedValueOnce(new Error('write failed'));
    const { POST } = await import('@/app/api/alerts/[id]/false-positive/route');
    const res = await POST(makePostRequest({ reason: 'whatever' }), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(500);
  });
});

// ===================== Method guards =====================

describe('methodNotAllowed stubs for /api/alerts/[id]/false-positive', () => {
  it.each([['GET'], ['PUT'], ['PATCH'], ['DELETE']])(
    '%s returns 405 with Allow: POST',
    async (method) => {
      const routeModule = await import('@/app/api/alerts/[id]/false-positive/route');
      const handler = (routeModule as unknown as Record<string, () => Promise<Response>>)[method];
      const res = await handler();
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('POST');
    },
  );
});
