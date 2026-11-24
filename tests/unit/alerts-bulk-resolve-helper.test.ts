// Pure-TS contract tests for the /alerts page's bulk "Resolve
// selected" helper (`runBulkResolve`). Updated for the new
// atomic batch endpoint (POST /api/alerts/resolve).
//
// Mirrors the bulk-reopen test suite's posture — helper-level
// scenarios stub-fake `fetch` and verify the contract:
//   1. Candidates = selection ∩ (status !== 'resolved'). Already-
//      resolved ids are silently skipped — no fetch fires.
//   2. ONE POST to /api/alerts/resolve with the trimmed body
//      envelope. Per-row failure (HTTP non-2xx, schema drift, or
//      per-id status mismatch) becomes an 'err' entry on the
//      outcome map for EVERY candidate (the response is binary
//      because the route's transaction is all-or-nothing).
//   3. All-OK optimistic flip mutates `data.items` to
//      `{ status: 'resolved' }` on targeted ids only.
//   4. Mixed outcome (an HTTP 502) preserves the original
//      `data.items` array — the page does NOT replace its state on
//      partial failure.
//   5. Empty selection → silent no-op (no fetches).
//   6. Body shape: `{ids: [...], note: <trimmed>}` on non-blank and
//      bare `{ids: [...]}` on blank/whitespace — so the route
//      stamps the trimmed value onto closingNote OR NULL on the
//      bare body.
//   7. Status filter is EXACTLY `!== 'resolved'` — a row that's
//      currently 'false_positive', 'open', or 'in_progress' is
//      still a valid resolve candidate (parity with the per-row
//      /resolve composer on the detail card that accepts any
//      non-resolved state).

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { describe, expect, it, vi } from 'vitest';
import { runBulkResolve } from '@/lib/business/alerts-bulk-resolve';
import type { AlertItem } from '@/lib/contracts/alerts';

function makeRow(
  id: string,
  status: 'open' | 'in_progress' | 'resolved' | 'false_positive',
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
    snoozedUntil: null,
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

function makeBulkEnvelope(ids: string[], note: string | null) {
  return {
    results: ids.map((id) => ({
      id,
      status: 'resolved' as const,
      statusChangedAt: '2026-07-02T09:00:00.000Z',
      acknowledgedAt: null,
      closedAt: '2026-07-02T09:00:00.000Z',
      closedBy: 'user-1',
      closingNote: note,
      reopenedAt: null,
      reopenedBy: null,
      reopenReason: null,
    })),
  };
}

function bulkResponse(envelope: unknown, status = 200) {
  return new Response(JSON.stringify(envelope), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('runBulkResolve — contract scenarios', () => {
  it('empty selection → silent no-op, no fetches fired, items unchanged', async () => {
    const items = [makeRow('a', 'open'), makeRow('b', 'resolved')];
    const fetchImpl = vi.fn();
    const result = await runBulkResolve({
      items,
      selection: new Set(),
      note: '',
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
    expect(result.outcomes.size).toBe(0);
    expect(result.allOk).toBe(true);
    expect(result.okCount).toBe(0);
    expect(result.items).toBe(items);
  });

  it('happy path: 3 selected open alerts → ONE POST with {ids,note}, optimistic flip', async () => {
    const items = [makeRow('a', 'open'), makeRow('b', 'open'), makeRow('c', 'open')];
    const selection = new Set(['a', 'b', 'c']);
    const captured: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      captured.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      return bulkResponse(makeBulkEnvelope(['a', 'b', 'c'], 'shared note'));
    });
    const result = await runBulkResolve({
      items,
      selection,
      note: 'shared note',
      fetchImpl,
    });
    // ONE fetch — the new endpoint resolves atomically.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(captured[0]?.url).toBe('/api/alerts/resolve');
    expect(captured[0]?.body).toEqual({ ids: ['a', 'b', 'c'], note: 'shared note' });
    expect(result.candidates.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.get('b')).toBe('ok');
    expect(result.outcomes.get('c')).toBe('ok');
    expect(result.allOk).toBe(true);
    expect(result.okCount).toBe(3);
    // Every targeted id is flipped to resolved.
    expect(result.items.every((r) => r.status === 'resolved')).toBe(true);
  });

  it('already-resolved: selection is fully already-resolved → no fetches fired', async () => {
    const items = [makeRow('a', 'resolved'), makeRow('b', 'resolved')];
    const fetchImpl = vi.fn();
    const result = await runBulkResolve({
      items,
      selection: new Set(['a', 'b']),
      note: '',
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
    expect(result.outcomes.size).toBe(0);
    expect(result.allOk).toBe(true);
    expect(result.okCount).toBe(0);
    expect(result.items).toBe(items);
  });

  it('mixed (open + already-resolved): pre-filter excludes already-resolved; only opens flip', async () => {
    // The brief explicitly says already-resolved is silently
    // skipped — matches the /resolve route's idempotent-already-
    // resolved branch so a stale click doesn't churn statusChangedAt.
    const aOpen = makeRow('a', 'open');
    const bOpen = makeRow('b', 'open');
    const cResolved = makeRow('c', 'resolved');
    const items = [aOpen, bOpen, cResolved];
    const selection = new Set(['a', 'b', 'c']);
    let lastBody: unknown = null;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      lastBody = JSON.parse(String(init?.body ?? '{}'));
      return bulkResponse(makeBulkEnvelope(['a', 'b'], null));
    });
    const result = await runBulkResolve({
      items,
      selection,
      note: '',
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Pre-filter: only `a` + `b` ship — `c` is silently skipped
    // pre-network.
    expect(lastBody).toEqual({ ids: ['a', 'b'] });
    expect(result.candidates.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(result.outcomes.has('c')).toBe(false);
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.get('b')).toBe('ok');
    // Post-flip row set: a + b resolved; c untouched.
    expect(result.items.find((r) => r.id === 'a')?.status).toBe('resolved');
    expect(result.items.find((r) => r.id === 'b')?.status).toBe('resolved');
    expect(result.items.find((r) => r.id === 'c')?.status).toBe('resolved');
    expect(result.allOk).toBe(true);
  });

  it('mixed (open + false_positive): FP rows ARE valid candidates', async () => {
    // The pre-filter is exactly `status !== 'resolved'`. A row
    // currently stamped as false_positive IS a valid resolve
    // candidate on the bulk path — the operator has explicitly
    // selected it, and the /resolve route accepts the
    // false_positive→resolved transition (clears the suppression
    // stamp and stamps the close trio).
    const aOpen = makeRow('a', 'open');
    const bFp = makeRow('b', 'false_positive');
    const items = [aOpen, bFp];
    const selection = new Set(['a', 'b']);
    const fetchImpl = vi.fn(async () => {
      return bulkResponse(makeBulkEnvelope(['a', 'b'], null));
    });
    const result = await runBulkResolve({
      items,
      selection,
      note: '',
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.get('b')).toBe('ok');
    expect(result.items.every((r) => r.status === 'resolved')).toBe(true);
    expect(result.allOk).toBe(true);
  });

  it('blank note → body has `{ids}` only (no `note` key) so route stamps NULL', async () => {
    const items = [makeRow('a', 'open'), makeRow('b', 'open')];
    const selection = new Set(['a', 'b']);
    const captured: { body: unknown }[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ body: JSON.parse(String(init?.body ?? '{}')) });
      return bulkResponse(makeBulkEnvelope(['a', 'b'], null));
    });
    const result = await runBulkResolve({
      items,
      selection,
      note: '',
      fetchImpl,
    });
    expect(result.allOk).toBe(true);
    expect(captured[0]?.body).toEqual({ ids: ['a', 'b'] });
    // No `note` key — server stamps NULL on the close trio's note
    // column for every row.
    expect(captured[0]?.body).not.toHaveProperty('note');
  });

  it('whitespace-only note → omit `note` key; body is `{ids}`', async () => {
    const items = [makeRow('a', 'open')];
    const selection = new Set(['a']);
    const captured: { body: unknown }[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ body: JSON.parse(String(init?.body ?? '{}')) });
      return bulkResponse(makeBulkEnvelope(['a'], null));
    });
    const result = await runBulkResolve({
      items,
      selection,
      note: '   \n  \t  ',
      fetchImpl,
    });
    expect(result.allOk).toBe(true);
    expect(captured[0]?.body).toEqual({ ids: ['a'] });
  });

  it('non-blank note is trimmed before the body is serialized', async () => {
    const items = [makeRow('a', 'open')];
    const selection = new Set(['a']);
    const captured: { body: unknown }[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ body: JSON.parse(String(init?.body ?? '{}')) });
      return bulkResponse(makeBulkEnvelope(['a'], 'patched'));
    });
    const result = await runBulkResolve({
      items,
      selection,
      note: '  patched  ',
      fetchImpl,
    });
    expect(result.allOk).toBe(true);
    expect(captured[0]?.body).toEqual({ ids: ['a'], note: 'patched' });
  });

  it('partial failure: HTTP 502 → allOk=false, all candidates err, items untouched', async () => {
    // The atomic-bulk endpoint returns a single status code — a 5xx
    // means NO write happened (the route's transaction either
    // commits or throws), so every candidate is `'err'` and the page
    // keeps its `data.items` reference unchanged.
    const items = [makeRow('a', 'open'), makeRow('b', 'open'), makeRow('c', 'open')];
    const selection = new Set(['a', 'b', 'c']);
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'bad gateway' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    });
    const result = await runBulkResolve({
      items,
      selection,
      note: '',
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.outcomes.get('a')).toBe('err');
    expect(result.outcomes.get('b')).toBe('err');
    expect(result.outcomes.get('c')).toBe('err');
    expect(result.allOk).toBe(false);
    expect(result.okCount).toBe(0);
    // Items reference unchanged — page does NOT call setData on
    // partial failure.
    expect(result.items).toBe(items);
    expect(result.items.every((r) => r.status === 'open')).toBe(true);
  });

  it('schema drift: 200 envelope returns a non-conformant shape → all err', async () => {
    // The AlertBulkResolveResponse schema rejects a literal `null`
    // body — `parsed.success` is false so the helper paints err on
    // every candidate and leaves items untouched.
    const items = [makeRow('a', 'open')];
    const selection = new Set(['a']);
    const fetchImpl = vi.fn(async () => {
      return new Response('null', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const result = await runBulkResolve({
      items,
      selection,
      note: '',
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.outcomes.get('a')).toBe('err');
    expect(result.allOk).toBe(false);
    expect(result.items).toBe(items);
  });

  it('mismatched per-id status: route returns a row with status != resolved → that row is err', async () => {
    // The route's per-id envelope carries the authoritative
    // `status` — a row that's still 'open' in the response is
    // painted 'err' by the helper even though the request returned
    // 200 with an envelope.
    const items = [makeRow('a', 'open'), makeRow('b', 'open')];
    const selection = new Set(['a', 'b']);
    const fetchImpl = vi.fn(async () => {
      return bulkResponse({
        results: [
          {
            id: 'a',
            status: 'resolved',
            statusChangedAt: '2026-07-02T09:00:00.000Z',
            acknowledgedAt: null,
            closedAt: '2026-07-02T09:00:00.000Z',
            closedBy: 'user-1',
            closingNote: null,
            reopenedAt: null,
            reopenedBy: null,
            reopenReason: null,
          },
          {
            id: 'b',
            status: 'open',
            statusChangedAt: null,
            acknowledgedAt: null,
            closedAt: null,
            closedBy: null,
            closingNote: null,
            reopenedAt: null,
            reopenedBy: null,
            reopenReason: null,
          },
        ],
      });
    });
    const result = await runBulkResolve({
      items,
      selection,
      note: '',
      fetchImpl,
    });
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.get('b')).toBe('err');
    expect(result.allOk).toBe(false);
    expect(result.okCount).toBe(1);
    // Items reference unchanged on partial failure.
    expect(result.items).toBe(items);
  });

  it('fetch throws (network reset) → all err, items untouched', async () => {
    const items = [makeRow('a', 'open'), makeRow('b', 'open')];
    const selection = new Set(['a', 'b']);
    const fetchImpl = vi.fn(async () => {
      throw new Error('network reset');
    });
    const result = await runBulkResolve({
      items,
      selection,
      note: '',
      fetchImpl,
    });
    expect(result.outcomes.get('a')).toBe('err');
    expect(result.outcomes.get('b')).toBe('err');
    expect(result.allOk).toBe(false);
    expect(result.items).toBe(items);
  });

  // ===================== snooze-arm pre-filter =====================
  //
  // Brief: snoozed alerts continue to appear in /alerts but
  // bulk-resolve must silently skip them so they remain
  // re-triagable later. The helper's page-side filter narrows
  // future-snoozed ids OUT of the POST body (the same posture as
  // already-resolved ids), so the route's silent-skip OR arm is a
  // belt-and-braces backstop rather than the load-bearing surface.

  it('mixed (open + future-snoozed): pre-filter excludes the future-snoozed id; only open flips', async () => {
    // A row whose `snoozedUntil` is still in the future is NOT a
    // candidate for bulk-resolve — the helper drops it from the
    // POST body so the page does not stamp a close trio over an
    // active snooze.
    const openA = makeRow('a', 'open');
    const openB = makeRow('b', 'open');
    const snoozedUntil = futureIso(7);
    const snoozedC = { ...makeRow('c', 'open'), snoozedUntil };
    const items = [openA, openB, snoozedC];
    const selection = new Set(['a', 'b', 'c']);
    let lastBody: unknown = null;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      lastBody = JSON.parse(String(init?.body ?? '{}'));
      return bulkResponse(makeBulkEnvelope(['a', 'b'], null));
    });
    const result = await runBulkResolve({
      items,
      selection,
      note: '',
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Pre-filter drops `c` from the POST body — only `a` + `b` ship.
    expect(lastBody).toEqual({ ids: ['a', 'b'] });
    expect(result.candidates.map((r) => r.id).sort()).toEqual(['a', 'b']);
    // No outcome entry for the snoozed id — matches already-resolved
    // omission posture so the page's indicator chips render nothing
    // for the row.
    expect(result.outcomes.has('c')).toBe(false);
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.get('b')).toBe('ok');
    // Post-flip row set: a + b flipped, c untouched (snooze wallet
    // intact so the operator can re-visit and un-snooze later).
    expect(result.items.find((r) => r.id === 'a')?.status).toBe('resolved');
    expect(result.items.find((r) => r.id === 'b')?.status).toBe('resolved');
    expect(result.items.find((r) => r.id === 'c')?.status).toBe('open');
    expect(result.items.find((r) => r.id === 'c')?.snoozedUntil).toBe(snoozedUntil);
    expect(result.allOk).toBe(true);
  });

  it('mixed (open + elapsed-snoozed): elapsed-snoozed IS a candidate (resurfaces on the bulk path)', async () => {
    // An elapsed snooze (`snoozedUntil <= now`) is treated exactly
    // like an un-snoozed row from the bulk-resolve perspective — the
    // list route already surfaces elapsed rows naturally, so the
    // helper's pre-filter must NOT silently drop them. The row flips
    // to resolved and the snoozeUntil stamp on the page-side items
    // mirrors whatever the in-memory snapshot already said.
    const openA = makeRow('a', 'open');
    const elapsedB = { ...makeRow('b', 'open'), snoozedUntil: pastIso(1) };
    const items = [openA, elapsedB];
    const selection = new Set(['a', 'b']);
    let lastBody: unknown = null;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      lastBody = JSON.parse(String(init?.body ?? '{}'));
      return bulkResponse(makeBulkEnvelope(['a', 'b'], null));
    });
    const result = await runBulkResolve({
      items,
      selection,
      note: '',
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(lastBody).toEqual({ ids: ['a', 'b'] });
    expect(result.candidates.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.get('b')).toBe('ok');
    expect(result.allOk).toBe(true);
  });

  it('all snoozed (future): no fetches fired (every candidate filtered pre-network)', async () => {
    // Belt-and-braces with the "all already-resolved" case: when
    // every selected id is future-snoozed, the helper's pre-filter
    // produces an empty candidate set and never fires the fetch.
    const items = [
      { ...makeRow('a', 'open'), snoozedUntil: futureIso(7) },
      { ...makeRow('b', 'open'), snoozedUntil: futureIso(30) },
    ];
    const fetchImpl = vi.fn();
    const result = await runBulkResolve({
      items,
      selection: new Set(['a', 'b']),
      note: '',
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
    expect(result.outcomes.size).toBe(0);
    expect(result.allOk).toBe(true);
    expect(result.okCount).toBe(0);
    expect(result.items).toBe(items);
  });

  it('malformed snoozedUntil (NaN parse): treated as not future-snoozed → row ships', async () => {
    // The list route already parses the column on the server so a
    // malformed ISO shouldn't reach the client; if it ever does the
    // helper treats it as not-future-snoozed rather than silently
    // dropping valid candidate ids.
    const items = [{ ...makeRow('a', 'open'), snoozedUntil: 'definitely-not-a-date' }];
    const fetchImpl = vi.fn(async () => bulkResponse(makeBulkEnvelope(['a'], null)));
    const result = await runBulkResolve({
      items,
      selection: new Set(['a']),
      note: '',
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.outcomes.get('a')).toBe('ok');
  });
});

function futureIso(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function pastIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}
