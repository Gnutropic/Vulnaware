// Bulk-false-positive tests for the /alerts page surface.
//
// Coverage posture mirrors tests/unit/alerts-bulk-reopen.test.tsx
// for the helper-level scenarios — happy path, role gate, idempotent
// no-op, mixed selection. Each scenario stub-fakes `fetch` and
// verifies the helper's contract:
//   1. Candidates = selection ∩ (status !== 'false_positive').
//      Already-FP ids are silently skipped — no fetch fires.
//   2. All-OK optimistic flip mutates `data.items` to
//      `{ status: 'false_positive', falsePositiveReason }` on
//      targeted ids only.
//   3. Mixed outcome (one HTTP 502) preserves the original
//      `data.items` array — the page does NOT replace its state on
//      partial failure.
//   4. Empty selection → silent no-op (no fetches).
//   5. Promise.allSettled isolates one fetch reject from the rest
//      of the batch.
//
// Why the helper path:
//   - The page handler reads `data.items`, `selection`,
//     `pendingBulkIds`, and writes `bulkResults`, `data.items`,
//     `selection` plus a sonner toast. To test it through React
//     we'd need to mock next/navigation, sonner, and mount the
//     full island; to test the contract we only need the
//     intermediate (data items, selection, stubbed fetch, reason)
//     and the emitted (outcomes map, post-flip items, allOk flag).
//     That intermediate set IS runBulkFalsePositive's surface.

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { describe, expect, it, vi } from 'vitest';
import { runBulkFalsePositive } from '@/lib/business/alerts-bulk-false-positive';
import type { AlertItem } from '@/lib/contracts/alerts';

const REASON = 'scanner mis-flagged TLS on a static site behind a WAF';

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

function makeFalsePositiveResponse(id: string) {
  return new Response(
    JSON.stringify({
      id,
      status: 'false_positive',
      statusChangedAt: '2026-07-02T09:00:00.000Z',
      acknowledgedAt: null,
      // The widened AlertFalsePositiveResponse (extends
      // AlertResolveResponse) carries the close-stamp trio. The trio
      // is null on an FP-only row (and was stamped-null after the
      // most recent reopen write on a previously-resolved row).
      closedAt: null,
      closedBy: null,
      closingNote: null,
      falsePositiveReason: REASON,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('runBulkFalsePositive — contract scenarios', () => {
  it('empty selection → silent no-op, no fetches fired, items unchanged', async () => {
    const items = [makeRow('a', 'open'), makeRow('b', 'resolved')];
    const fetchImpl = vi.fn();
    const result = await runBulkFalsePositive({
      items,
      selection: new Set(),
      reason: REASON,
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
    expect(result.outcomes.size).toBe(0);
    expect(result.allOk).toBe(true);
    expect(result.okCount).toBe(0);
    expect(result.items).toBe(items);
  });

  it('parallel happy path: 3 non-FP ids — fan out, paint ok, flip state with reason stamp', async () => {
    const a = makeRow('a', 'open');
    const b = makeRow('b', 'in_progress');
    const c = makeRow('c', 'resolved');
    const items = [a, b, c];
    const selection = new Set(['a', 'b', 'c']);
    const called: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const match = url.match(/\/api\/alerts\/([^/]+)\/false-positive/);
      const id = match?.[1] ?? '';
      called.push(id);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      // Verify the same reason rides every POST body.
      expect(body.reason).toBe(REASON);
      return makeFalsePositiveResponse(id);
    });
    const result = await runBulkFalsePositive({
      items,
      selection,
      reason: REASON,
      fetchImpl,
    });
    expect(called.sort()).toEqual(['a', 'b', 'c']);
    expect(result.candidates.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.get('b')).toBe('ok');
    expect(result.outcomes.get('c')).toBe('ok');
    expect(result.allOk).toBe(true);
    expect(result.okCount).toBe(3);
    expect(result.items.every((r) => r.status === 'false_positive')).toBe(true);
    expect(result.items.every((r) => r.falsePositiveReason === REASON)).toBe(true);
  });

  it('role gate: 403 from /false-positive paints err, leaves items untouched, allOk=false', async () => {
    const a = makeRow('a', 'open');
    const b = makeRow('b', 'open');
    const items = [a, b];
    const selection = new Set(['a', 'b']);
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    });
    const result = await runBulkFalsePositive({
      items,
      selection,
      reason: REASON,
      fetchImpl,
    });
    expect(result.outcomes.get('a')).toBe('err');
    expect(result.outcomes.get('b')).toBe('err');
    expect(result.allOk).toBe(false);
    expect(result.okCount).toBe(0);
    // Items unchanged on partial failure — the page's optimistic flip
    // is gated on allOk, so a single 4xx/5xx must not silently re-render
    // non-FP rows as 'false_positive' before the operator retries.
    expect(result.items).toBe(items);
    expect(result.items.every((r) => r.status === 'open')).toBe(true);
  });

  it('idempotent no-op: already-FP id in selection is silently skipped — no fetch fired', async () => {
    const aOpen = makeRow('a', 'open');
    const bOpen = makeRow('b', 'open');
    const cFp = makeRow('c', 'false_positive');
    const items = [aOpen, bOpen, cFp];
    const selection = new Set(['a', 'b', 'c']);
    const called: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const match = url.match(/\/api\/alerts\/([^/]+)\/false-positive/);
      const id = match?.[1] ?? '';
      called.push(id);
      return makeFalsePositiveResponse(id);
    });
    const result = await runBulkFalsePositive({
      items,
      selection,
      reason: REASON,
      fetchImpl,
    });
    // Pre-filter rejects status === 'false_positive'; the already-FP id
    // is dropped from the fan-out.
    expect(called.sort()).toEqual(['a', 'b']);
    expect(result.candidates.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(result.outcomes.has('c')).toBe(false);
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.get('b')).toBe('ok');
    expect(result.items.find((r) => r.id === 'c')?.status).toBe('false_positive');
    // Post-flip row set: a+b flipped to false_positive; c untouched.
    expect(result.items.find((r) => r.id === 'a')?.status).toBe('false_positive');
    expect(result.items.find((r) => r.id === 'b')?.status).toBe('false_positive');
    expect(result.items.find((r) => r.id === 'a')?.falsePositiveReason).toBe(REASON);
    expect(result.allOk).toBe(true);
  });

  it('mixed selection: 2 FP + 2 open, all selected — only non-FP flip; final state all FP', async () => {
    const items = [
      makeRow('a', 'open'),
      makeRow('b', 'open'),
      makeRow('c', 'false_positive'),
      makeRow('d', 'false_positive'),
    ];
    const selection = new Set(['a', 'b', 'c', 'd']);
    const called: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const match = url.match(/\/api\/alerts\/([^/]+)\/false-positive/);
      const id = match?.[1] ?? '';
      called.push(id);
      return makeFalsePositiveResponse(id);
    });
    const result = await runBulkFalsePositive({
      items,
      selection,
      reason: REASON,
      fetchImpl,
    });
    expect(called.sort()).toEqual(['a', 'b']);
    expect(result.outcomes.size).toBe(2);
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.get('b')).toBe('ok');
    expect(result.allOk).toBe(true);
    expect(result.okCount).toBe(2);
    expect(result.items.every((r) => r.status === 'false_positive')).toBe(true);
    // The reason rides every flipped row; the already-FP rows keep
    // their pre-existing null (no overwrite from this helper).
    expect(result.items.find((r) => r.id === 'a')?.falsePositiveReason).toBe(REASON);
    expect(result.items.find((r) => r.id === 'c')?.falsePositiveReason).toBeNull();
  });

  it('mixed HTTP outcomes: 1 ok + 1 502 — preserves data.items, allOk=false', async () => {
    const a = makeRow('a', 'open');
    const b = makeRow('b', 'open');
    const items = [a, b];
    const selection = new Set(['a', 'b']);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const match = url.match(/\/api\/alerts\/([^/]+)\/false-positive/);
      const id = match?.[1] ?? '';
      if (id === 'a') return makeFalsePositiveResponse(id);
      return new Response(JSON.stringify({ error: 'bad gateway' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    });
    const result = await runBulkFalsePositive({
      items,
      selection,
      reason: REASON,
      fetchImpl,
    });
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.get('b')).toBe('err');
    expect(result.allOk).toBe(false);
    expect(result.okCount).toBe(1);
    // On partial failure, the post-flip items array is the SAME
    // reference as the input (page does NOT call setData on partial
    // failure). The page uses this reference identity to skip the
    // setState on the failure branch.
    expect(result.items).toBe(items);
    expect(result.items.every((r) => r.status === 'open')).toBe(true);
  });

  it('rejects with non-ok + non-false-positive envelope → outcome is err', async () => {
    // Schema-drift envelope: 200 but missing the false_positive status.
    // Helper paints err so the page does not mark the row FP.
    const a = makeRow('a', 'open');
    const items = [a];
    const selection = new Set(['a']);
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'a',
          status: 'resolved',
          statusChangedAt: '2026-07-02T09:00:00.000Z',
          acknowledgedAt: null,
          closedAt: null,
          closedBy: null,
          closingNote: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const result = await runBulkFalsePositive({
      items,
      selection,
      reason: REASON,
      fetchImpl,
    });
    expect(result.outcomes.get('a')).toBe('err');
    expect(result.allOk).toBe(false);
    expect(result.items).toBe(items);
  });
});
