// @vitest-environment node
// Unit tests for POST /api/alerts/snooze-batch — the atomic bulk-snooze
// companion to POST /api/alerts/[id]/snooze. Posture mirrors
// tests/unit/api/alerts-bulk-resolve-route.test.ts:
//   - vi.mock('server-only') so the module loads
//   - vi.mock('@/lib/db') exposing the prisma.alert.{findMany,update}
//     surface the route touches AND a prisma.$transaction shim that
//     satisfies the array-of-promises form.
//   - vi.mock('@/lib/team-auth') with a swappable requireTeamRole whose
//     thrown Response encodes the 401/403 gates.
//
// Asserted:
//   - 401 anon, 403 below-member — opaque, body untouched by the
//     route's parse step.
//   - 400 malformed JSON body.
//   - 400 ids:[] (.min(1) — no empty-selection write path).
//   - 400 undisclosed field (.strict()).
//   - 200 happy path N ids: every row's snoozedUntil stamps the same
//     window; envelope echoes {id, snoozedUntil} per row.
//   - 200 idempotent refresh: a row with a prior snoozedUntil gets
//     the new stamp; no prior-value gate.
//   - 200 silent cross-team drop: cross-team ids are dropped from
//     BOTH the transaction and the envelope (deliberate divergence
//     from POST /api/alerts/resolve's 404 posture).
//   - 200 empty overlap: every id is cross-team/missing; envelope is
//     {results: []}; HTTP stays 200.
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

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = { '1d': DAY_MS, '3d': 3 * DAY_MS, '7d': 7 * DAY_MS, '30d': 30 * DAY_MS };

function makePostRequest(body: unknown) {
  return new Request('http://test/api/alerts/snooze-batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
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

// ===================== POST /api/alerts/snooze-batch =====================

function makeScopeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-1',
    teamId: 'team-1',
    ...overrides,
  };
}

describe('POST /api/alerts/snooze-batch', () => {
  it('returns 401 when there is no session', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Unauthorized' }, { status: 401 });
    });
    const { POST } = await import('@/app/api/alerts/snooze-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'], duration: '7d' }));
    expect(res.status).toBe(401);
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertTransaction).not.toHaveBeenCalled();
  });

  it('returns 403 when caller is below member', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Forbidden' }, { status: 403 });
    });
    const { POST } = await import('@/app/api/alerts/snooze-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'], duration: '7d' }));
    expect(res.status).toBe(403);
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertTransaction).not.toHaveBeenCalled();
  });

  it('returns 400 when the body is malformed JSON', async () => {
    const req = new Request('http://test/api/alerts/snooze-batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    const { POST } = await import('@/app/api/alerts/snooze-batch/route');
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertTransaction).not.toHaveBeenCalled();
  });

  it('returns 400 when ids is empty (.min(1))', async () => {
    const { POST } = await import('@/app/api/alerts/snooze-batch/route');
    const res = await POST(makePostRequest({ ids: [], duration: '7d' }));
    expect(res.status).toBe(400);
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertTransaction).not.toHaveBeenCalled();
  });

  it('returns 400 when an undisclosed field is included (.strict())', async () => {
    const { POST } = await import('@/app/api/alerts/snooze-batch/route');
    const res = await POST(
      makePostRequest({ ids: ['alert-1'], duration: '7d', evilField: 'extra' }),
    );
    expect(res.status).toBe(400);
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertTransaction).not.toHaveBeenCalled();
  });

  it('happy path: 3 ids all get the same snoozedUntil stamp', async () => {
    alertFindMany.mockResolvedValueOnce([
      makeScopeRow({ id: 'alert-1' }),
      makeScopeRow({ id: 'alert-2' }),
      makeScopeRow({ id: 'alert-3' }),
    ]);
    alertUpdate.mockImplementation(
      async (args: { where: { id: string }; data: { snoozedUntil: Date } }) => ({
        id: args.where.id,
        teamId: 'team-1',
        snoozedUntil: args.data.snoozedUntil,
      }),
    );

    const beforeMs = Date.now();
    const { POST } = await import('@/app/api/alerts/snooze-batch/route');
    const res = await POST(
      makePostRequest({ ids: ['alert-1', 'alert-2', 'alert-3'], duration: '7d' }),
    );
    const afterMs = Date.now();
    expect(res.status).toBe(200);
    expect(alertTransaction).toHaveBeenCalledTimes(1);
    expect(alertUpdate).toHaveBeenCalledTimes(3);
    // Every updated row carries the same Date stamped.
    const stampTimes: number[] = [];
    for (const call of alertUpdate.mock.calls) {
      const data = (call[0] as { data: { snoozedUntil: Date } }).data;
      expect(data.snoozedUntil).toBeInstanceOf(Date);
      stampTimes.push(data.snoozedUntil.getTime());
    }
    for (const t of stampTimes) expect(t).toBe(stampTimes[0]);
    // The stamp is roughly `now + 7d` — within a 50ms window to absorb
    // the small drift between `beforeMs` and the route's internal
    // `Date.now()`.
    const expected = beforeMs + WINDOW_MS['7d'];
    const actual = stampTimes[0] ?? 0;
    expect(Math.abs(actual - expected)).toBeLessThan(50);
    // And it must NOT have drifted past `afterMs + 7d`.
    expect(actual).toBeLessThanOrEqual(afterMs + WINDOW_MS['7d']);
    const body = await res.json();
    expect(body.results).toHaveLength(3);
    expect(body.results.map((r: { id: string }) => r.id).sort()).toEqual([
      'alert-1',
      'alert-2',
      'alert-3',
    ]);
    for (const r of body.results) expect(typeof r.snoozedUntil).toBe('string');
  });

  it('idempotent refresh: prior snoozedUntil is overwritten without a prior-value gate', async () => {
    // Pre-set an earlier `snoozedUntil` on the row. The stubbed
    // findMany returns it; the route's update must still receive the
    // NEW stamp (NOT gated by `if snoozedUntil == null`).
    const EARLIER = new Date(Date.now() - 60 * 60 * 1000);
    alertFindMany.mockResolvedValueOnce([makeScopeRow({ id: 'alert-1', snoozedUntil: EARLIER })]);
    alertUpdate.mockImplementation(
      async (args: { where: { id: string }; data: { snoozedUntil: Date } }) => ({
        id: args.where.id,
        teamId: 'team-1',
        snoozedUntil: args.data.snoozedUntil,
      }),
    );
    const beforeMs = Date.now();
    const { POST } = await import('@/app/api/alerts/snooze-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'], duration: '30d' }));
    expect(res.status).toBe(200);
    expect(alertUpdate).toHaveBeenCalledTimes(1);
    const data = (alertUpdate.mock.calls[0]?.[0] as { data: { snoozedUntil: Date } }).data;
    // The stamped Date is the NEW value (30d from now), NOT the
    // earlier prior snoozedUntil.
    const expected = beforeMs + WINDOW_MS['30d'];
    expect(Math.abs(data.snoozedUntil.getTime() - expected)).toBeLessThan(50);
    expect(data.snoozedUntil.getTime()).not.toBe(EARLIER.getTime());
    const body = await res.json();
    expect(body.results[0].snoozedUntil).not.toBe(EARLIER.toISOString());
  });

  it('silent cross-team drop: request includes [in-team, cross-team, in-team], tx + envelope = 2', async () => {
    // Pin the deliberate divergence from /api/alerts/resolve's
    // opaque-404 posture: cross-team ids are SILENTLY dropped from
    // both the transaction array AND the response envelope. HTTP
    // stays 200. A copy-paste drift back to 404 fails this test.
    alertFindMany.mockResolvedValueOnce([
      makeScopeRow({ id: 'a-in-team' }),
      makeScopeRow({ id: 'c-in-team' }),
    ]);
    alertUpdate.mockImplementation(
      async (args: { where: { id: string }; data: { snoozedUntil: Date } }) => ({
        id: args.where.id,
        teamId: 'team-1',
        snoozedUntil: args.data.snoozedUntil,
      }),
    );
    const { POST } = await import('@/app/api/alerts/snooze-batch/route');
    const res = await POST(
      makePostRequest({
        ids: ['a-in-team', 'b-cross-team', 'c-in-team'],
        duration: '7d',
      }),
    );
    expect(res.status).toBe(200);
    // The transaction len is 2 (in-team ids only), NOT 3.
    const txArg = alertTransaction.mock.calls[0]?.[0];
    expect(Array.isArray(txArg)).toBe(true);
    expect((txArg as unknown[]).length).toBe(2);
    // alertUpdate only fires on the two in-team rows.
    expect(alertUpdate).toHaveBeenCalledTimes(2);
    const updateIds = alertUpdate.mock.calls.map(
      (c) => (c[0] as { where: { id: string } }).where.id,
    );
    expect(updateIds.sort()).toEqual(['a-in-team', 'c-in-team']);
    // Cross-team id NEVER reaches any update.
    expect(updateIds).not.toContain('b-cross-team');
    // Envelope echoes ONLY the two in-team rows.
    const body = await res.json();
    expect(body.results).toHaveLength(2);
    expect(body.results.map((r: { id: string }) => r.id).sort()).toEqual([
      'a-in-team',
      'c-in-team',
    ]);
  });

  it('empty overlap: every id is cross-team/missing → tx is [] + envelope is {results: []} + HTTP 200', async () => {
    // Brief divergence from /resolve: even when ALL ids are
    // missing/cross-team, the route returns 200 with an empty
    // results array (NOT a 404).
    alertFindMany.mockResolvedValueOnce([]);
    const { POST } = await import('@/app/api/alerts/snooze-batch/route');
    const res = await POST(makePostRequest({ ids: ['missing-1', 'missing-2'], duration: '7d' }));
    expect(res.status).toBe(200);
    // Transaction is NOT invoked when the live id set is empty.
    expect(alertTransaction).not.toHaveBeenCalled();
    expect(alertUpdate).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body).toEqual({ results: [] });
  });

  it('defence-in-depth: cross-team write on the transaction row → opaque 404', async () => {
    // Pact-defensive: a tampered race produced a cross-team row in
    // the transaction result. The route SHOULD bail to opaque 404
    // inside the defence-in-depth loop even though the scope-pass
    // already filtered cross-team ids out.
    alertFindMany.mockResolvedValueOnce([makeScopeRow({ id: 'alert-1' })]);
    alertUpdate.mockImplementationOnce(async () => ({
      id: 'alert-1',
      teamId: 'team-OTHER',
      snoozedUntil: new Date(Date.now() + WINDOW_MS['7d']),
    }));
    const { POST } = await import('@/app/api/alerts/snooze-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'], duration: '7d' }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'not_found' });
  });

  it('returns 500 when the DB throws on the scope-check', async () => {
    alertFindMany.mockRejectedValueOnce(new Error('db down'));
    const { POST } = await import('@/app/api/alerts/snooze-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'], duration: '7d' }));
    expect(res.status).toBe(500);
  });

  it('returns 500 when the $transaction throws', async () => {
    alertFindMany.mockResolvedValueOnce([makeScopeRow({ id: 'alert-1' })]);
    alertTransaction.mockRejectedValueOnce(new Error('write failed'));
    const { POST } = await import('@/app/api/alerts/snooze-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'], duration: '7d' }));
    expect(res.status).toBe(500);
  });

  it('reaches a 1d/3d/7d/30d stamp target within tolerance for each duration', async () => {
    for (const duration of ['1d', '3d', '7d', '30d'] as const) {
      vi.resetModules();
      alertFindMany.mockReset();
      alertUpdate.mockReset();
      alertTransaction.mockReset();
      installTransactionShim();
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
      alertFindMany.mockResolvedValueOnce([makeScopeRow({ id: 'alert-1' })]);
      alertUpdate.mockImplementation(
        async (args: { where: { id: string }; data: { snoozedUntil: Date } }) => ({
          id: args.where.id,
          teamId: 'team-1',
          snoozedUntil: args.data.snoozedUntil,
        }),
      );
      const beforeMs = Date.now();
      const { POST } = await import('@/app/api/alerts/snooze-batch/route');
      const res = await POST(makePostRequest({ ids: ['alert-1'], duration }));
      const afterMs = Date.now();
      expect(res.status).toBe(200);
      const data = (alertUpdate.mock.calls[0]?.[0] as { data: { snoozedUntil: Date } }).data;
      const stampedMs = data.snoozedUntil.getTime();
      // Stamp must sit between `beforeMs + window` and `afterMs + window`.
      expect(stampedMs).toBeGreaterThanOrEqual(beforeMs + WINDOW_MS[duration]);
      expect(stampedMs).toBeLessThanOrEqual(afterMs + WINDOW_MS[duration]);
    }
  });

  it('deduplicates duplicate ids in the request before the scope check', async () => {
    // A caller posting ['alert-1', 'alert-1', 'alert-2'] must NOT
    // issue 3 distinct updates — the dedup happens before the
    // transaction so the live set is 2, not 3.
    alertFindMany.mockResolvedValueOnce([
      makeScopeRow({ id: 'alert-1' }),
      makeScopeRow({ id: 'alert-2' }),
    ]);
    alertUpdate.mockImplementation(
      async (args: { where: { id: string }; data: { snoozedUntil: Date } }) => ({
        id: args.where.id,
        teamId: 'team-1',
        snoozedUntil: args.data.snoozedUntil,
      }),
    );
    const { POST } = await import('@/app/api/alerts/snooze-batch/route');
    const res = await POST(
      makePostRequest({ ids: ['alert-1', 'alert-1', 'alert-2'], duration: '7d' }),
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

  // ===================== `until` arm =====================

  it('until arm: future ISO stamps verbatim, no WINDOW_MS ligation', async () => {
    // The new `until` arm bypasses the `now + WINDOW_MS` table — the
    // server echoes the client-supplied ISO directly so the
    // operator's future pick lands exactly the moment they typed in
    // the floating bar's custom-date input.
    const FUTURE_ISO = '2027-01-15T08:00:00.000Z';
    const futureMs = Date.parse(FUTURE_ISO);
    alertFindMany.mockResolvedValueOnce([
      makeScopeRow({ id: 'alert-1' }),
      makeScopeRow({ id: 'alert-2' }),
    ]);
    alertUpdate.mockImplementation(
      async (args: { where: { id: string }; data: { snoozedUntil: Date } }) => ({
        id: args.where.id,
        teamId: 'team-1',
        snoozedUntil: args.data.snoozedUntil,
      }),
    );
    const { POST } = await import('@/app/api/alerts/snooze-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1', 'alert-2'], until: FUTURE_ISO }));
    expect(res.status).toBe(200);
    expect(alertTransaction).toHaveBeenCalledTimes(1);
    expect(alertUpdate).toHaveBeenCalledTimes(2);
    // Both rows carry the same Date from the FUTURE_ISO literal —
    // NOT `now + WINDOW_MS[<duration>]`.
    for (const call of alertUpdate.mock.calls) {
      const data = (call[0] as { data: { snoozedUntil: Date } }).data;
      expect(data.snoozedUntil).toBeInstanceOf(Date);
      expect(data.snoozedUntil.getTime()).toBe(futureMs);
    }
    const body = await res.json();
    expect(body.results).toHaveLength(2);
    for (const r of body.results) expect(r.snoozedUntil).toBe(FUTURE_ISO);
  });

  it('until arm: past ISO is ACCEPTED (no 400) — list surfaces immediately on next refresh', async () => {
    // Posture parity with POST /api/alerts/[id]/snooze: a past ISO is
    // honored. The /alerts list route narrows by
    // `(IS NULL OR <= now)` so a past-dated snooze surfaces the row
    // immediately on the next refresh — the operator may want to
    // effectively un-snooze-via-route (the [id] SnoozeCard uses this
    // for the past-pick undo branch). Ignoring past ISOs here would
    // break parity with the single-id route.
    const PAST_ISO = '2020-01-01T00:00:00.000Z';
    alertFindMany.mockResolvedValueOnce([makeScopeRow({ id: 'alert-1' })]);
    alertUpdate.mockImplementation(
      async (args: { where: { id: string }; data: { snoozedUntil: Date } }) => ({
        id: args.where.id,
        teamId: 'team-1',
        snoozedUntil: args.data.snoozedUntil,
      }),
    );
    const { POST } = await import('@/app/api/alerts/snooze-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'], until: PAST_ISO }));
    expect(res.status).toBe(200);
    expect(alertUpdate).toHaveBeenCalledTimes(1);
    const data = (alertUpdate.mock.calls[0]?.[0] as { data: { snoozedUntil: Date } }).data;
    expect(data.snoozedUntil.getTime()).toBe(Date.parse(PAST_ISO));
  });

  it('until arm: `until: null` writes NULL on every row (explicit un-snooze)', async () => {
    // The bulk route's until arm mirrors the single-id route's
    // `until: null` semantics: `null` clears `snoozedUntil` on every
    // row in the batch. Today the floating bar's Apply button does
    // not surface this branch (the `<input type="date">` always
    // emits a future ISO from the typed pick), but the route's
    // contract accepts it for parity with the single-id snooze route
    // AND so a future "Bulk un-snooze" arm can wire through the
    // same union without a schema widening.
    alertFindMany.mockResolvedValueOnce([
      makeScopeRow({ id: 'alert-1' }),
      makeScopeRow({ id: 'alert-2' }),
    ]);
    alertUpdate.mockImplementation(
      async (args: { where: { id: string }; data: { snoozedUntil: Date | null } }) => ({
        id: args.where.id,
        teamId: 'team-1',
        snoozedUntil: args.data.snoozedUntil,
      }),
    );
    const { POST } = await import('@/app/api/alerts/snooze-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1', 'alert-2'], until: null }));
    expect(res.status).toBe(200);
    expect(alertUpdate).toHaveBeenCalledTimes(2);
    for (const call of alertUpdate.mock.calls) {
      const data = (call[0] as { data: { snoozedUntil: Date | null } }).data;
      expect(data.snoozedUntil).toBeNull();
    }
    const body = await res.json();
    for (const r of body.results) expect(r.snoozedUntil).toBeNull();
  });

  it('until arm: invalid ISO 400s through the refine BEFORE the scope gate', async () => {
    // The union's `until` refine is `length>0 && !isNaN(Date.parse)`
    // — matches the single-id route's posture verbatim so a UI typo
    // is caught at the schema layer BEFORE any DB read. Critically:
    // the scope gate MUST NOT have fired (alertFindMany is unused),
    // pinning the parse-first ordering.
    const { POST } = await import('@/app/api/alerts/snooze-batch/route');
    const res = await POST(makePostRequest({ ids: ['alert-1'], until: 'definitely-not-a-date' }));
    expect(res.status).toBe(400);
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertTransaction).not.toHaveBeenCalled();
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('until arm: silent cross-team drop preserved on the future-ISO body shape', async () => {
    // The cross-team drop is a route-level invariant, NOT duration
    // specific. Pin it on the `until` arm so a future drift that
    // re-routes scope-check depending on arm shape fails here.
    alertFindMany.mockResolvedValueOnce([
      makeScopeRow({ id: 'in-1' }),
      makeScopeRow({ id: 'in-2' }),
    ]);
    alertUpdate.mockImplementation(
      async (args: { where: { id: string }; data: { snoozedUntil: Date } }) => ({
        id: args.where.id,
        teamId: 'team-1',
        snoozedUntil: args.data.snoozedUntil,
      }),
    );
    const FUTURE_ISO = '2027-01-15T08:00:00.000Z';
    const { POST } = await import('@/app/api/alerts/snooze-batch/route');
    const res = await POST(
      makePostRequest({
        ids: ['in-1', 'cross-team', 'in-2'],
        until: FUTURE_ISO,
      }),
    );
    expect(res.status).toBe(200);
    const txArg = alertTransaction.mock.calls[0]?.[0];
    expect(Array.isArray(txArg)).toBe(true);
    expect((txArg as unknown[]).length).toBe(2);
    const updateIds = alertUpdate.mock.calls.map(
      (c) => (c[0] as { where: { id: string } }).where.id,
    );
    expect(updateIds.sort()).toEqual(['in-1', 'in-2']);
    expect(updateIds).not.toContain('cross-team');
    const body = await res.json();
    expect(body.results).toHaveLength(2);
  });

  it('until arm: empty overlap → tx is [] + envelope is {results: []} + HTTP 200', async () => {
    // Mirror of the duration arm's empty-overlap branch on the
    // until arm. The route returns 200 with an empty results array
    // (NOT a 404) — cross-team / missing ids are silently dropped.
    alertFindMany.mockResolvedValueOnce([]);
    const { POST } = await import('@/app/api/alerts/snooze-batch/route');
    const res = await POST(
      makePostRequest({ ids: ['missing-1', 'missing-2'], until: '2027-01-15T08:00:00.000Z' }),
    );
    expect(res.status).toBe(200);
    expect(alertTransaction).not.toHaveBeenCalled();
    expect(alertUpdate).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body).toEqual({ results: [] });
  });
});

// ===================== Method guards =====================

describe('methodNotAllowed stubs for /api/alerts/snooze-batch', () => {
  it.each([['GET'], ['PUT'], ['PATCH'], ['DELETE']])(
    '%s returns 405 with Allow: POST',
    async (method) => {
      const routeModule = await import('@/app/api/alerts/snooze-batch/route');
      const handler = (routeModule as unknown as Record<string, () => Promise<Response>>)[method];
      const res = await handler();
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('POST');
    },
  );
});
