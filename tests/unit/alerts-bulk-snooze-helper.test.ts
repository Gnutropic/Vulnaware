// Pure-TS contract tests for the /alerts page's bulk "Snooze
// selected" helper (`runBulkSnooze`). Mirrors the bulk-resolve test
// suite's posture — helper-level scenarios stub-fake `fetch` and
// verify the contract:
//
//   1. Status pre-filter drops `status === 'resolved'` rows from
//      the candidate set. Re-stamping `snoozedUntil` on a closed
//      row is never meaningful — the row's terminal state should
//      not pick up a snooze stamp. Already-snoozed rows STILL re-
//      stamp on the bulk path (idempotent refresh), mirroring the
//      runBulkResolve posture's dropped-resolved branch.
//   2. ONE POST to /api/alerts/snooze-batch with `{ids, …}` body.
//      The optional `…` is either a shared `duration` literal (1d /
//      3d / 7d / 30d) OR a client-supplied ISO `until` (the new
//      custom-date arm). Per-row failure (HTTP non-2xx, schema
//      drift, or a per-id missing from the envelope) becomes 'err'
//      on the outcome map for that id only — the page's bar paints
//      the indicator chip accordingly.
//   3. All-OK optimistic flip stamps ONLY `snoozedUntil` on every
//      targeted id (no status flip, no acknowledgedAt,
//      statusChangedAt) so the row card re-renders with the new
//      `Snoozed until …` stamp. The new stamp is the SERVER-echoed
//      value — on the duration arm that's `now + WINDOW_MS[…]`, on
//      the until arm it's the verbatim ISO the operator picked.
//   4. Empty selection → silent no-op (no fetches).
//   5. Body shape mirror of `AlertBulkSnoozeBody`'s union: a
//      `target: { kind: 'duration', duration }` produces
//      `{ids, duration}`, a `target: { kind: 'until', until }`
//      produces `{ids, until}`. The discriminated `kind` keeps the
//      two arms apart so a copy-paste drift fails BOTH the type
//      layer (the body shape) AND the unit suite (the shape assertion).
//   6. Schema drift on the body is not testable inside the helper
//      (the helper's internal `safeParse` guards it).

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { describe, expect, it, vi } from 'vitest';
import { runBulkSnooze } from '@/lib/business/alerts-bulk-snooze';
import type { AlertItem } from '@/lib/contracts/alerts';

function makeRow(
  id: string,
  status: 'open' | 'in_progress' | 'resolved' | 'false_positive',
  snoozedUntil: string | null = null,
): AlertItem {
  return {
    id,
    teamId: 'team-1',
    findingId: `f-${id}`,
    severity: 'high',
    status,
    source: 'kev',
    assigneeId: null,
    ownerId: null,
    ownerName: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    acknowledgedAt: null,
    snoozedUntil,
    cveId: `CVE-2026-1${id}`,
    vulnerabilityTitle: 'test vuln',
    asset: { host: 'edge.example.com', port: 443, protocol: 'tcp' },
    triggeredBy: 'ci-webhook',
    commentCount: 0,
    falsePositiveReason: null,
    closingNote: null,
    remediatedAt: null,
  };
}

function makeBulkEnvelope(ids: string[], stampIso: string) {
  return {
    results: ids.map((id) => ({ id, snoozedUntil: stampIso })),
  };
}

function bulkResponse(envelope: unknown, status = 200): Response {
  return new Response(JSON.stringify(envelope), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('runBulkSnooze — contract scenarios (duration arm)', () => {
  it('empty selection → silent no-op, no fetches fired, items unchanged', async () => {
    const items = [makeRow('a', 'open'), makeRow('b', 'resolved')];
    const fetchImpl = vi.fn();
    const result = await runBulkSnooze({
      items,
      selection: new Set(),
      target: { kind: 'duration', duration: '7d' },
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
    expect(result.outcomes.size).toBe(0);
    expect(result.allOk).toBe(true);
    expect(result.okCount).toBe(0);
    expect(result.items).toBe(items);
  });

  it('happy path: 3 selected open alerts → ONE POST with {ids, duration}, optimistic flip on snoozedUntil only', async () => {
    const items = [makeRow('a', 'open'), makeRow('b', 'open'), makeRow('c', 'open')];
    const selection = new Set(['a', 'b', 'c']);
    const beforePlusSeven = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const captured: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      captured.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      return bulkResponse(makeBulkEnvelope(['a', 'b', 'c'], beforePlusSeven));
    });
    const result = await runBulkSnooze({
      items,
      selection,
      target: { kind: 'duration', duration: '7d' },
      fetchImpl,
    });
    // ONE fetch — the new endpoint stamps atomically.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(captured[0]?.url).toBe('/api/alerts/snooze-batch');
    expect(captured[0]?.body).toEqual({ ids: ['a', 'b', 'c'], duration: '7d' });
    expect(result.candidates.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.get('b')).toBe('ok');
    expect(result.outcomes.get('c')).toBe('ok');
    expect(result.allOk).toBe(true);
    expect(result.okCount).toBe(3);
    // Every targeted id got the new stamp is exposed on items.
    const after = result.items;
    expect(after.find((r) => r.id === 'a')?.snoozedUntil).toBe(beforePlusSeven);
    expect(after.find((r) => r.id === 'b')?.snoozedUntil).toBe(beforePlusSeven);
    expect(after.find((r) => r.id === 'c')?.snoozedUntil).toBe(beforePlusSeven);
    // Status untouched — the bulk path is purely a snooze stamp.
    for (const r of after) expect(r.status).toBe('open');
  });

  it('already-snoozed row IS a candidate: bulk route re-stamps the window', async () => {
    // Divergence from runBulkResolve: already-snoozed ids are NOT
    // pre-filtered. The bulk route's idempotent-refresh contract
    // means re-applying "Snooze 7d" refreshes the window.
    const EARLIER = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const items = [makeRow('a', 'open', EARLIER)];
    const NEW_STAMP = new Date(Date.now() + 7 * 86_400_000).toISOString();
    let lastBody: unknown = null;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      lastBody = JSON.parse(String(init?.body ?? '{}'));
      return bulkResponse(makeBulkEnvelope(['a'], NEW_STAMP));
    });
    const result = await runBulkSnooze({
      items,
      selection: new Set(['a']),
      target: { kind: 'duration', duration: '7d' },
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(lastBody).toEqual({ ids: ['a'], duration: '7d' });
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.allOk).toBe(true);
    // The new stamp from the envelope wins on the optimistic flip.
    expect(result.items.find((r) => r.id === 'a')?.snoozedUntil).toBe(NEW_STAMP);
  });

  it('row with status === "resolved" is silently dropped from the candidate set', async () => {
    // Already-resolved rows are pre-filtered out of the working set
    // before any fetch fires. Re-stamping `snoozedUntil` on a closed
    // row is never meaningful — the row's terminal state should not
    // pick up a snooze stamp. Mirror of runBulkResolve's posture.
    const items = [makeRow('a', 'resolved'), makeRow('b', 'resolved')];
    const fetchImpl = vi.fn();
    const result = await runBulkSnooze({
      items,
      selection: new Set(['a', 'b']),
      target: { kind: 'duration', duration: '7d' },
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
    expect(result.outcomes.size).toBe(0);
    expect(result.allOk).toBe(true);
    expect(result.okCount).toBe(0);
    // Items reference unchanged when no fetch fires.
    expect(result.items).toBe(items);
  });

  it('mixed selection: resolved rows dropped, non-resolved rows fanned out', async () => {
    // The helper drops already-resolved ids from the helper-side
    // candidate set while still letting the rest of the working set
    // fan out to /snooze-batch. The page-side bar builds
    // `pendingBulkIds` off the same pre-filter so a `Mark selected
    // snoozed` gesture on a mixed set never strands the resolved
    // ids in a pending state.
    const items = [makeRow('a', 'resolved'), makeRow('b', 'open'), makeRow('c', 'in_progress')];
    const NEW_STAMP = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const fetchImpl = vi.fn(async () => bulkResponse(makeBulkEnvelope(['b', 'c'], NEW_STAMP)));
    const result = await runBulkSnooze({
      items,
      selection: new Set(['a', 'b', 'c']),
      target: { kind: 'duration', duration: '7d' },
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.candidates.map((r) => r.id).sort()).toEqual(['b', 'c']);
    expect(result.outcomes.get('a')).toBeUndefined();
    expect(result.outcomes.get('b')).toBe('ok');
    expect(result.outcomes.get('c')).toBe('ok');
    expect(result.allOk).toBe(true);
    expect(result.okCount).toBe(2);
  });

  it('body shape for each duration literal', async () => {
    const items = [makeRow('a', 'open')];
    for (const duration of ['1d', '3d', '7d', '30d'] as const) {
      const captured: { body: unknown }[] = [];
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        captured.push({ body: JSON.parse(String(init?.body ?? '{}')) });
        return bulkResponse(makeBulkEnvelope(['a'], new Date(Date.now()).toISOString()));
      });
      const result = await runBulkSnooze({
        items,
        selection: new Set(['a']),
        target: { kind: 'duration', duration },
        fetchImpl,
      });
      expect(result.allOk).toBe(true);
      expect(captured[0]?.body).toEqual({ ids: ['a'], duration });
    }
  });

  it('partial failure: envelope missing one id → that row is err, allOk=false, items untouched', async () => {
    // The route echoes the per-id set it actually wrote. Missing ids
    // are painted 'err' even on a 200 response — the helper is
    // paranoid enough to treat them as failures so the page's bar
    // surfaces a meaningful partial-failure toast.
    const items = [makeRow('a', 'open'), makeRow('b', 'open')];
    const NEW_STAMP = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const fetchImpl = vi.fn(async () => bulkResponse(makeBulkEnvelope(['a'], NEW_STAMP)));
    const result = await runBulkSnooze({
      items,
      selection: new Set(['a', 'b']),
      target: { kind: 'duration', duration: '7d' },
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.get('b')).toBe('err');
    expect(result.allOk).toBe(false);
    expect(result.okCount).toBe(1);
    // Items reference unchanged on partial failure.
    expect(result.items).toBe(items);
  });

  it('non-2xx response: every candidate is err, items untouched', async () => {
    const items = [makeRow('a', 'open'), makeRow('b', 'open')];
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'bad gateway' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    });
    const result = await runBulkSnooze({
      items,
      selection: new Set(['a', 'b']),
      target: { kind: 'duration', duration: '7d' },
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.outcomes.get('a')).toBe('err');
    expect(result.outcomes.get('b')).toBe('err');
    expect(result.allOk).toBe(false);
    expect(result.items).toBe(items);
  });

  it('schema drift: 200 envelope with non-conformant shape → all err, items untouched', async () => {
    const items = [makeRow('a', 'open')];
    const fetchImpl = vi.fn(async () => {
      return new Response('null', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const result = await runBulkSnooze({
      items,
      selection: new Set(['a']),
      target: { kind: 'duration', duration: '7d' },
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.outcomes.get('a')).toBe('err');
    expect(result.allOk).toBe(false);
    expect(result.items).toBe(items);
  });

  it('fetch throws (network reset) → all err, items untouched', async () => {
    const items = [makeRow('a', 'open'), makeRow('b', 'open')];
    const fetchImpl = vi.fn(async () => {
      throw new Error('network reset');
    });
    const result = await runBulkSnooze({
      items,
      selection: new Set(['a', 'b']),
      target: { kind: 'duration', duration: '7d' },
      fetchImpl,
    });
    expect(result.outcomes.get('a')).toBe('err');
    expect(result.outcomes.get('b')).toBe('err');
    expect(result.allOk).toBe(false);
    expect(result.items).toBe(items);
  });

  it('selection ids not present in items: silently dropped (no fetch fires for unknown id)', async () => {
    // The page parses selection from the URL via `parseSelectedParam`
    // which is permissive — a stale `?selected=<unknown>` should not
    // break the helper. The pre-filter narrows to `selection ∩
    // items`, so unknown ids are silently skipped.
    const items = [makeRow('a', 'open')];
    const NEW_STAMP = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const fetchImpl = vi.fn(async () => bulkResponse(makeBulkEnvelope(['a'], NEW_STAMP)));
    const result = await runBulkSnooze({
      items,
      selection: new Set(['a', 'unknown']),
      target: { kind: 'duration', duration: '7d' },
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.candidates.map((r) => r.id)).toEqual(['a']);
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.has('unknown')).toBe(false);
    expect(result.allOk).toBe(true);
  });
});

// ===================== Custom-date (`until`) arm =====================

describe('runBulkSnooze — contract scenarios (until arm)', () => {
  it('happy path: 2 selected open alerts → ONE POST with {ids, until}, optimistic flip echoes server ISO', async () => {
    // The `until` arm passes a client-supplied ISO through to the
    // route, and the route echoes that ISO verbatim in the per-row
    // envelope. The optimistic flip mirrors the server-echoed ISO
    // onto every targeted row so the row's `Snoozed until …` badge
    // reads the operator's pick, not a re-derived client moment.
    const FUTURE_ISO = '2027-01-15T08:00:00.000Z';
    const items = [makeRow('a', 'open'), makeRow('b', 'open')];
    const selection = new Set(['a', 'b']);
    const captured: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      captured.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      return bulkResponse(makeBulkEnvelope(['a', 'b'], FUTURE_ISO));
    });
    const result = await runBulkSnooze({
      items,
      selection,
      target: { kind: 'until', until: FUTURE_ISO },
      fetchImpl,
    });
    // ONE POST carrying the client-supplied ISO.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(captured[0]?.url).toBe('/api/alerts/snooze-batch');
    // Body shape — `until` only, NOT `duration`. Mirrors the route's
    // union: each arm is .strict() so a body with both keys 400s.
    expect(captured[0]?.body).toEqual({ ids: ['a', 'b'], until: FUTURE_ISO });
    expect(result.candidates.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.get('b')).toBe('ok');
    expect(result.allOk).toBe(true);
    expect(result.okCount).toBe(2);
    // The verbatim server-echoed ISO lands on every targeted row.
    expect(result.items.find((r) => r.id === 'a')?.snoozedUntil).toBe(FUTURE_ISO);
    expect(result.items.find((r) => r.id === 'b')?.snoozedUntil).toBe(FUTURE_ISO);
    // Status untouched.
    for (const r of result.items) expect(r.status).toBe('open');
  });

  it('until arm: body emits `until` key, NEVER `duration` (lockstep with AlertBulkSnoozeBody union)', async () => {
    // Discriminated union pill: a `target: { kind: 'until' }` must
    // NOT accidentally produce a `{ids, duration}` body. Pin the
    // body shape so a future drift (e.g. someone ALWAYS spreads
    // `duration') fails here before it reaches the wire.
    const items = [makeRow('a', 'open')];
    const captured: { body: unknown }[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ body: JSON.parse(String(init?.body ?? '{}')) });
      return bulkResponse(makeBulkEnvelope(['a'], '2027-01-15T08:00:00.000Z'));
    });
    await runBulkSnooze({
      items,
      selection: new Set(['a']),
      target: { kind: 'until', until: '2027-01-15T08:00:00.000Z' },
      fetchImpl,
    });
    const body = captured[0]?.body as Record<string, unknown>;
    expect(body).toEqual({ ids: ['a'], until: '2027-01-15T08:00:00.000Z' });
    expect(body).not.toHaveProperty('duration');
  });

  it('until arm: partial failure → painted "err" on missing ids', async () => {
    // Mirror of the duration arm's partial-failure test: missing from
    // the envelope → 'err'. Optimistic flip stays untouched on
    // partial-failure so the bar paints a meaningful indicator chip
    // for the missing row.
    const items = [makeRow('a', 'open'), makeRow('b', 'open')];
    const FUTURE_ISO = '2027-01-15T08:00:00.000Z';
    const fetchImpl = vi.fn(async () => bulkResponse(makeBulkEnvelope(['a'], FUTURE_ISO)));
    const result = await runBulkSnooze({
      items,
      selection: new Set(['a', 'b']),
      target: { kind: 'until', until: FUTURE_ISO },
      fetchImpl,
    });
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.get('b')).toBe('err');
    expect(result.allOk).toBe(false);
    expect(result.okCount).toBe(1);
    expect(result.items).toBe(items);
  });

  it('until arm: non-2xx → every candidate is err', async () => {
    const items = [makeRow('a', 'open'), makeRow('b', 'open')];
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'bad gateway' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    });
    const result = await runBulkSnooze({
      items,
      selection: new Set(['a', 'b']),
      target: { kind: 'until', until: '2027-01-15T08:00:00.000Z' },
      fetchImpl,
    });
    expect(result.outcomes.get('a')).toBe('err');
    expect(result.outcomes.get('b')).toBe('err');
    expect(result.allOk).toBe(false);
    expect(result.items).toBe(items);
  });

  it('until arm: already-snoozed rows re-stamped verbatim (idempotent refresh posture)', async () => {
    // Mirror of the duration arm's "already-snoozed row IS a
    // candidate" — the only difference is the row surfaces the
    // client-supplied ISO, NOT `now + 7d`.
    const EARLIER = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const FUTURE_ISO = '2027-01-15T08:00:00.000Z';
    const items = [makeRow('a', 'open', EARLIER)];
    const fetchImpl = vi.fn(async () => bulkResponse(makeBulkEnvelope(['a'], FUTURE_ISO)));
    const result = await runBulkSnooze({
      items,
      selection: new Set(['a']),
      target: { kind: 'until', until: FUTURE_ISO },
      fetchImpl,
    });
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.allOk).toBe(true);
    // The new ISO is the verbatim client pick — earlier snoozedUntil
    // is overwritten.
    expect(result.items.find((r) => r.id === 'a')?.snoozedUntil).toBe(FUTURE_ISO);
  });
});
