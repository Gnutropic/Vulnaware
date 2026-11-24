// @vitest-environment node
// Unit tests for POST /api/alerts/resolve — the atomic bulk-resolve
// companion to POST /api/alerts/[id]/resolve. Posture mirrors
// tests/unit/api/alerts-resolve-route.test.ts:
//   - vi.mock('server-only') so the module loads
//   - vi.mock('@/lib/db') exposing the prisma.alert surface the route
//     touches AND a prisma.$transaction shim that satisfies the
//     array-of-promises form the bulk route uses for atomicity.
//   - vi.mock('@/lib/team-auth') with a swappable requireTeamRole whose
//     thrown Response encodes the 401/403 gates.
//
// Asserted:
//   - 401 anon, 403 below-member — opaque, body untouched by the
//     route's parse step
//   - 400 malformed JSON body
//   - 400 ids:[] (.min(1) — no empty-selection write path)
//   - 400 note > 500 chars
//   - 400 undisclosed field (.strict())
//   - 404 opaque when any id is cross-team or missing
//   - 200 happy path N ids: all flip to 'resolved' in a single tx,
//     shared `now` so every closedAt / statusChangedAt matches
//   - 200 already-resolved + no-note: rows are silently skipped,
//     envelope echoes on-disk state without churning timestamps
//   - 200 already-resolved + note: partial update on
//     closingNote + statusChangedAt only (close-stamp trio preserved)
//   - 200 false_positive → resolved: status flip, stamps trio
//   - 500 on DB throw
//   - GET/PUT/PATCH/DELETE → 405 with Allow: POST

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const alertFindMany = vi.fn();
const alertFindFirst = vi.fn();
const alertFindUnique = vi.fn();
const alertUpdate = vi.fn();
const alertTransaction = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    alert: {
      findMany: alertFindMany,
      findFirst: alertFindFirst,
      findUnique: alertFindUnique,
      update: alertUpdate,
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

const RESOLVED_AT = new Date('2026-07-02T09:00:00Z');

function makePostRequest(body: unknown) {
  return new Request('http://test/api/alerts/resolve', {
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
    closedAt: RESOLVED_AT,
    closedBy: 'user-original',
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

// Snooze-armed row — `snoozedUntil` is selected (per the route's
// `findMany select`) so the route's snooze-arm gate can drop future-
// snoozed rows out of `liveExisting`. Defaults to a future window
// (7d) so the gate keeps it out of the transaction; override via
// `overrides.snoozedUntil` to flip the row back into the bulk-resolve
// path.
function makeSnoozedRow(overrides: Record<string, unknown> = {}) {
  return makeOpenRow({
    snoozedUntil: new Date(Date.now() + 7 * 86_400_000),
    ...overrides,
  });
}

// Mock prisma.$transaction so the array-of-promises form
// (bulk route's atomic posture) just `Promise.all`s the inner
// promises. This keeps the test a pure-TS stub of the route's call
// surface — no real DB, no real transaction isolation.
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
});

// ===================== POST /api/alerts/resolve =====================

describe('POST /api/alerts/resolve', () => {
  it('returns 401 when there is no session', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Unauthorized' }, { status: 401 });
    });
    const { POST } = await import('@/app/api/alerts/resolve/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'] }));
    expect(res.status).toBe(401);
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertTransaction).not.toHaveBeenCalled();
  });

  it('returns 403 when caller is below member', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Forbidden' }, { status: 403 });
    });
    const { POST } = await import('@/app/api/alerts/resolve/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'] }));
    expect(res.status).toBe(403);
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertTransaction).not.toHaveBeenCalled();
  });

  it('returns 400 when the body is malformed JSON', async () => {
    const req = new Request('http://test/api/alerts/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    const { POST } = await import('@/app/api/alerts/resolve/route');
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertTransaction).not.toHaveBeenCalled();
  });

  it('returns 400 when ids is empty (.min(1))', async () => {
    const { POST } = await import('@/app/api/alerts/resolve/route');
    const res = await POST(makePostRequest({ ids: [] }));
    expect(res.status).toBe(400);
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertTransaction).not.toHaveBeenCalled();
  });

  it('returns 400 when note is >500 chars (zod max)', async () => {
    const { POST } = await import('@/app/api/alerts/resolve/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'], note: 'x'.repeat(501) }));
    expect(res.status).toBe(400);
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertTransaction).not.toHaveBeenCalled();
  });

  it('returns 400 when an undisclosed field is included (.strict())', async () => {
    const { POST } = await import('@/app/api/alerts/resolve/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'], note: 'ok', evilField: 'extra' }));
    expect(res.status).toBe(400);
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertTransaction).not.toHaveBeenCalled();
  });

  it('returns opaque 404 when any id is cross-team', async () => {
    alertFindMany.mockResolvedValueOnce([makeOpenRow({ id: 'alert-1' })]);
    const { POST } = await import('@/app/api/alerts/resolve/route');
    const res = await POST(makePostRequest({ ids: ['alert-1', 'alert-2'] }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'not_found' });
    expect(alertTransaction).not.toHaveBeenCalled();
  });

  it('returns opaque 404 when any id is fully missing', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    const { POST } = await import('@/app/api/alerts/resolve/route');
    const res = await POST(makePostRequest({ ids: ['alert-1', 'alert-2'] }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'not_found' });
    expect(alertTransaction).not.toHaveBeenCalled();
  });

  it('happy path: 3 open ids flip to resolved in one tx with shared now', async () => {
    // Scope check returns the three rows; the tx shim runs each
    // update and returns the resolved trio. The shared `now` is on
    // every row's updated close trio so an auditor can group flips
    // from the same bulk action.
    alertFindMany.mockResolvedValueOnce([
      makeOpenRow({ id: 'alert-1' }),
      makeOpenRow({ id: 'alert-2' }),
      makeOpenRow({ id: 'alert-3' }),
    ]);
    const UPDATED = new Date('2026-07-02T09:00:00Z');
    const stubbedResolved = (id: string) =>
      makeResolvedUpdatedRow({
        id,
        statusChangedAt: UPDATED,
        closedAt: UPDATED,
        closedBy: 'user-1',
        closingNote: null,
      });
    alertUpdate.mockImplementation(
      async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        return stubbedResolved(args.where.id);
      },
    );

    const { POST } = await import('@/app/api/alerts/resolve/route');
    const res = await POST(makePostRequest({ ids: ['alert-1', 'alert-2', 'alert-3'] }));
    expect(res.status).toBe(200);
    // All three updates flow through one $transaction call.
    expect(alertTransaction).toHaveBeenCalledTimes(1);
    // alertFindUnique is NOT called on the FIRST-write path — only
    // the already-resolved no-note branch uses it.
    expect(alertFindUnique).not.toHaveBeenCalled();
    // Every updated row carries the shared `now` values.
    expect(alertUpdate).toHaveBeenCalledTimes(3);
    for (const call of alertUpdate.mock.calls) {
      const data = (call[0] as { data: Record<string, unknown> }).data;
      expect(data.status).toBe('resolved');
      expect(data.closedAt).toBeInstanceOf(Date);
      expect(data.statusChangedAt).toBeInstanceOf(Date);
      const closedAt = data.closedAt as Date;
      const statusChangedAt = data.statusChangedAt as Date;
      expect(closedAt.getTime()).toBe(statusChangedAt.getTime());
    }
    const body = await res.json();
    expect(body.results).toHaveLength(3);
    expect(body.results.map((r: { id: string; status: string }) => [r.id, r.status])).toEqual([
      ['alert-1', 'resolved'],
      ['alert-2', 'resolved'],
      ['alert-3', 'resolved'],
    ]);
    for (const r of body.results) {
      expect(r.closedAt).toBeTruthy();
      expect(r.closedBy).toBe('user-1');
      expect(r.closingNote).toBeNull();
    }
  });

  it('flips a false_positive row to resolved and stamps the trio', async () => {
    alertFindMany.mockResolvedValueOnce([makeOpenRow({ id: 'alert-1', status: 'false_positive' })]);
    alertUpdate.mockImplementation(
      async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        return makeResolvedUpdatedRow({
          id: args.where.id,
          statusChangedAt: RESOLVED_AT,
          closedAt: RESOLVED_AT,
          closedBy: 'user-1',
          closingNote: null,
        });
      },
    );
    const { POST } = await import('@/app/api/alerts/resolve/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'] }));
    expect(res.status).toBe(200);
    expect(alertUpdate).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.results[0].status).toBe('resolved');
  });

  it('already-resolved + no note: no UPDATE fires, envelope echoes on-disk state', async () => {
    // The idempotent branch reads the row via findUnique inside the
    // tx and returns the on-disk state without firing prisma.update.
    alertFindMany.mockResolvedValueOnce([makeResolvedRow({ id: 'alert-1' })]);
    alertFindUnique.mockResolvedValueOnce(makeResolvedRow({ id: 'alert-1' }));
    const { POST } = await import('@/app/api/alerts/resolve/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'] }));
    expect(res.status).toBe(200);
    expect(alertUpdate).not.toHaveBeenCalled();
    expect(alertFindUnique).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.results[0].status).toBe('resolved');
    expect(body.results[0].closedAt).toBe(RESOLVED_AT.toISOString());
    expect(body.results[0].closedBy).toBe('user-original');
    expect(body.results[0].closingNote).toBe('Closed in scope');
  });

  it('already-resolved + note: UPDATE fires only for closingNote + statusChangedAt', async () => {
    // Partial update path — closingNote + statusChangedAt only;
    // closedAt / closedBy encode first-write identity and are
    // NEVER overwritten. Status is NOT in the data set.
    alertFindMany.mockResolvedValueOnce([makeResolvedRow({ id: 'alert-1' })]);
    const REFRESH = new Date('2026-07-03T08:00:00Z');
    alertUpdate.mockImplementation(
      async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
        ...makeResolvedRow({ id: args.where.id }),
        statusChangedAt: REFRESH,
        closingNote: 'fresh note',
      }),
    );
    const { POST } = await import('@/app/api/alerts/resolve/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'], note: 'fresh note' }));
    expect(res.status).toBe(200);
    expect(alertUpdate).toHaveBeenCalledTimes(1);
    const call = alertUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(call.data.statusChangedAt).toBeInstanceOf(Date);
    expect(call.data.closingNote).toBe('fresh note');
    expect(call.data).not.toHaveProperty('status');
    expect(call.data).not.toHaveProperty('closedAt');
    expect(call.data).not.toHaveProperty('closedBy');
    const body = await res.json();
    expect(body.results[0].closingNote).toBe('fresh note');
    expect(body.results[0].statusChangedAt).toBe(REFRESH.toISOString());
    expect(body.results[0].closedAt).toBe(RESOLVED_AT.toISOString());
    expect(body.results[0].closedBy).toBe('user-original');
  });

  it('mixed batch (with note): 1 open flips (first-write), 1 already-resolved gets partial update', async () => {
    // Two rows, two different write paths. The route must pick
    // the right path for each row AND share the SAME now-stamp on
    // the rows that actually flip / refresh.
    const UPDATED_STAMP = new Date('2026-07-02T09:00:00Z');
    alertFindMany.mockResolvedValueOnce([
      makeOpenRow({ id: 'open-1' }),
      makeResolvedRow({ id: 'resolved-1' }),
    ]);
    alertUpdate.mockImplementation(
      async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        if (args.where.id === 'open-1') {
          // First-write: closingNote carries the trimmed note onto the
          // row, mirroring what Prisma.update would return after
          // applying the route's data set.
          return makeResolvedUpdatedRow({
            id: 'open-1',
            statusChangedAt: UPDATED_STAMP,
            closedAt: UPDATED_STAMP,
            closedBy: 'user-1',
            closingNote: 'shared note',
          });
        }
        // resolved-1 partial update on closingNote + statusChangedAt.
        return makeResolvedRow({
          id: 'resolved-1',
          statusChangedAt: UPDATED_STAMP,
          closingNote: 'shared note',
        });
      },
    );

    const { POST } = await import('@/app/api/alerts/resolve/route');
    const res = await POST(makePostRequest({ ids: ['open-1', 'resolved-1'], note: 'shared note' }));
    expect(res.status).toBe(200);
    // Both rows go through prisma.alert.update — open-1 first-write,
    // resolved-1 partial update. No findUnique (note is non-null).
    expect(alertUpdate).toHaveBeenCalledTimes(2);
    expect(alertFindUnique).not.toHaveBeenCalled();
    const updateIds = alertUpdate.mock.calls.map(
      (c) => (c[0] as { where: { id: string } }).where.id,
    );
    expect(updateIds.sort()).toEqual(['open-1', 'resolved-1']);
    const body = await res.json();
    const byId = new Map(body.results.map((r: { id: string }) => [r.id, r]));
    // open-1: first-write — fresh close-stamp trio + shared note.
    expect(byId.get('open-1')).toMatchObject({ status: 'resolved', closingNote: 'shared note' });
    // resolved-1: partial update — note refreshed, close-trio preserved.
    expect(byId.get('resolved-1')).toMatchObject({
      status: 'resolved',
      closingNote: 'shared note',
    });
  });

  it('returns 404 if any updated row yields a cross-team write (defence-in-depth)', async () => {
    alertFindMany.mockResolvedValueOnce([makeOpenRow({ id: 'alert-1' })]);
    alertUpdate.mockImplementationOnce(async () => ({
      id: 'alert-1',
      teamId: 'team-OTHER',
      status: 'resolved',
      statusChangedAt: RESOLVED_AT,
      acknowledgedAt: null,
      closedAt: RESOLVED_AT,
      closedBy: 'user-1',
      closingNote: null,
      reopenedAt: null,
      reopenedBy: null,
      reopenReason: null,
    }));
    const { POST } = await import('@/app/api/alerts/resolve/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'] }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'not_found' });
  });

  it('returns 500 when the DB throws on the scope-check', async () => {
    alertFindMany.mockRejectedValueOnce(new Error('db down'));
    const { POST } = await import('@/app/api/alerts/resolve/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'] }));
    expect(res.status).toBe(500);
  });

  it('returns 500 when the $transaction throws', async () => {
    alertFindMany.mockResolvedValueOnce([makeOpenRow({ id: 'alert-1' })]);
    alertTransaction.mockRejectedValueOnce(new Error('write failed'));
    const { POST } = await import('@/app/api/alerts/resolve/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'] }));
    expect(res.status).toBe(500);
  });

  // ===================== Snooze-arm gate on /api/alerts/resolve =====================
  //
  // Brief: snoozed alerts continue to surface in /alerts but
  // bulk-resolve must silently skip them so they remain
  // re-triagable later. The route's snooze-arm gate drops future-
  // snoozed rows out of `liveExisting` BEFORE the transaction so
  // neither a close trio nor a transaction row stamp is fired on
  // them. The envelope echoes only the ids the route actually
  // flipped.

  it('snooze-arm gate: future-snoozed row is silently dropped from the transaction + envelope', async () => {
    // Scope check pulls both rows AND selects `snoozedUntil` so the
    // route can gate. `alert-1` is open and un-snoozed; `alert-2`
    // is open but snoozed for 7 days in the future. Per the brief,
    // `alert-2` should fall through the route with neither a write
    // nor an envelope entry.
    alertFindMany.mockResolvedValueOnce([
      makeOpenRow({ id: 'alert-1' }),
      makeSnoozedRow({ id: 'alert-2' }),
    ]);
    alertUpdate.mockImplementation(
      async (args: { where: { id: string }; data: Record<string, unknown> }) =>
        makeResolvedUpdatedRow({ id: args.where.id }),
    );
    const { POST } = await import('@/app/api/alerts/resolve/route');
    const res = await POST(makePostRequest({ ids: ['alert-1', 'alert-2'] }));
    expect(res.status).toBe(200);
    // Only ONE update fires — `alert-1` flips to resolved; the
    // snoozed `alert-2` never reaches the transaction.
    expect(alertUpdate).toHaveBeenCalledTimes(1);
    const updateIds = alertUpdate.mock.calls.map(
      (c) => (c[0] as { where: { id: string } }).where.id,
    );
    expect(updateIds).toEqual(['alert-1']);
    // Envelope echoes ONLY the ids the route flipped; the snoozed
    // id is absent from `results` so the caller can derive the
    // silent-skip posture from the by-id difference.
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].id).toBe('alert-1');
    expect(body.results[0].status).toBe('resolved');
  });

  it('snooze-arm gate: elapsed-snoozed row falls through (resurfaces on bulk path)', async () => {
    // The list route treats snoozedUntil <= now as "ready to
    // surface", so elapsed-snoozed rows reach bulk-resolve as
    // ordinary candidates. The route's gate is strictly
    // future-only — a past snooze is no block.
    const elapsedRow = makeOpenRow({
      id: 'alert-1',
      snoozedUntil: new Date(Date.now() - 60 * 1000),
    });
    alertFindMany.mockResolvedValueOnce([elapsedRow]);
    alertUpdate.mockImplementation(
      async (args: { where: { id: string }; data: Record<string, unknown> }) =>
        makeResolvedUpdatedRow({ id: args.where.id }),
    );
    const { POST } = await import('@/app/api/alerts/resolve/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'] }));
    expect(res.status).toBe(200);
    expect(alertUpdate).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].id).toBe('alert-1');
  });

  it('snooze-arm gate: returns opaque 404 when a missing-id is mixed with future-snoozed (cross-team vs snooze indistinguishable)', async () => {
    // Opaque-404 contract: scope-check length mismatch (any id
    // missing / cross-team) always returns not_found regardless
    // of the snooze state. The route does NOT short-circuit the
    // 404 just because the missing id is also snoozed — that
    // would leak existence via the snooze column.
    alertFindMany.mockResolvedValueOnce([makeOpenRow({ id: 'alert-1' })]);
    const { POST } = await import('@/app/api/alerts/resolve/route');
    const res = await POST(makePostRequest({ ids: ['alert-1', 'alert-missing', 'alert-snoozed'] }));
    expect(res.status).toBe(404);
    expect(alertUpdate).not.toHaveBeenCalled();
  });
});

// ===================== Method guards =====================

describe('methodNotAllowed stubs for /api/alerts/resolve', () => {
  it.each([['GET'], ['PUT'], ['PATCH'], ['DELETE']])(
    '%s returns 405 with Allow: POST',
    async (method) => {
      const routeModule = await import('@/app/api/alerts/resolve/route');
      const handler = (routeModule as unknown as Record<string, () => Promise<Response>>)[method];
      const res = await handler();
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('POST');
    },
  );
});
