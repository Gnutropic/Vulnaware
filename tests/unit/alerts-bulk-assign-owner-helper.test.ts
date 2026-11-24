// Pure-TS contract tests for the /alerts page's bulk
// "Assign owner…" helper (`runBulkAssignOwner`). Mirrors the
// bulk-snooze / bulk-take-ownership test suites' posture —
// helper-level scenarios stub-fake `fetch` and verify the
// contract:
//
//   1. NO already-owned / status pre-filter — every selected row
//      IS a candidate. The bulk route's idempotent-refresh
//      posture means re-applying the same owner is an
//      idempotent success; the helper does NOT short-circuit
//      pre-network.
//   2. ONE POST to /api/alerts/assign-owner-batch with `{ids,
//      ownerId}` body. Per-row failure (HTTP non-2xx, schema
//      drift, or a per-id missing from the envelope) becomes
//      'err' on the outcome map.
//   3. All-OK optimistic flip stamps BOTH `ownerId` AND
//      `ownerName` on every targeted id (the page-resolved
//      pair, NOT a re-derived server moment).
//   4. Empty selection → silent no-op.
//   5. `ownerId = null` (the "Unassigned" arm) → silent
//      no-fetch short-circuit. The bulk route's `ownerId: null`
//      arm is wired for a future "Bulk unassign" gesture; the
//      helper pins the v1 forward-only posture.
//   6. Selection ids not present in items are silently dropped
//      (no fetch for unknown ids).

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { describe, expect, it, vi } from 'vitest';
import { runBulkAssignOwner } from '@/lib/business/alerts-bulk-assign-owner';
import type { AlertItem } from '@/lib/contracts/alerts';

const PICKED_WM_ID = 'wm-picked';
const OTHER_WM_ID = 'wm-other';

function makeRow(
  id: string,
  ownerId: string | null = OTHER_WM_ID,
  ownerName: string | null = 'Other User',
): AlertItem {
  return {
    id,
    teamId: 'team-1',
    findingId: `f-${id}`,
    severity: 'high',
    status: 'open',
    source: 'kev',
    assigneeId: null,
    ownerId,
    ownerName,
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
    remediatedByEmail: null,
    lastActivityAt: null,
    lastExplainedAt: null,
    lastExplanationText: null,
  };
}

function makeEnvelope(rows: Array<{ id: string; ownerId: string; ownerName: string | null }>) {
  return { results: rows };
}

function assignResponse(envelope: unknown, status = 200): Response {
  return new Response(JSON.stringify(envelope), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('runBulkAssignOwner — contract scenarios', () => {
  it('empty selection → silent no-op, no fetches fired, items unchanged', async () => {
    const items = [makeRow('a'), makeRow('b')];
    const fetchImpl = vi.fn();
    const result = await runBulkAssignOwner({
      items,
      selection: new Set(),
      ownerId: PICKED_WM_ID,
      ownerName: 'Picked Name',
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
    expect(result.outcomes.size).toBe(0);
    expect(result.allOk).toBe(true);
    expect(result.okCount).toBe(0);
    expect(result.items).toBe(items);
  });

  it('ownerId = null → silent no-fetch short-circuit (forward-only v1 posture)', async () => {
    // The "Unassigned" arm: `ownerId: null` skips the fetch
    // entirely. The bulk route accepts `ownerId: null` (it
    // clears the FK), but the bulk gesture today is operator-
    // driven; a future "Bulk unassign" gesture would surface
    // through this helper as a fresh call-site, not a body
    // shape change.
    const items = [makeRow('a'), makeRow('b')];
    const fetchImpl = vi.fn();
    const result = await runBulkAssignOwner({
      items,
      selection: new Set(['a', 'b']),
      ownerId: null,
      ownerName: null,
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
    expect(result.outcomes.size).toBe(0);
    expect(result.allOk).toBe(true);
    expect(result.okCount).toBe(0);
    expect(result.items).toBe(items);
  });

  it('happy path: 3 selected rows → ONE POST with {ids, ownerId}, optimistic flip stamps BOTH fields', async () => {
    const items = [
      makeRow('a', OTHER_WM_ID),
      makeRow('b', OTHER_WM_ID),
      makeRow('c'), // unowned
    ];
    const selection = new Set(['a', 'b', 'c']);
    const captured: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      captured.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      return assignResponse(
        makeEnvelope([
          { id: 'a', ownerId: PICKED_WM_ID, ownerName: 'Picked Name' },
          { id: 'b', ownerId: PICKED_WM_ID, ownerName: 'Picked Name' },
          { id: 'c', ownerId: PICKED_WM_ID, ownerName: 'Picked Name' },
        ]),
      );
    });
    const result = await runBulkAssignOwner({
      items,
      selection,
      ownerId: PICKED_WM_ID,
      ownerName: 'Picked Name',
      fetchImpl,
    });
    // ONE fetch — the new endpoint stamps atomically.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(captured[0]?.url).toBe('/api/alerts/assign-owner-batch');
    expect(captured[0]?.body).toEqual({ ids: ['a', 'b', 'c'], ownerId: PICKED_WM_ID });
    expect(result.candidates.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.get('b')).toBe('ok');
    expect(result.outcomes.get('c')).toBe('ok');
    expect(result.allOk).toBe(true);
    expect(result.okCount).toBe(3);
    // Every targeted id picked up the page-resolved ownerId +
    // ownerName on the optimistic flip. (Mirrors ownership-batch
    // but the flip happens regardless of prior `item.ownerId` —
    // already-owned rows are NOT pre-filtered.)
    const after = result.items;
    expect(after.find((r) => r.id === 'a')?.ownerId).toBe(PICKED_WM_ID);
    expect(after.find((r) => r.id === 'a')?.ownerName).toBe('Picked Name');
    expect(after.find((r) => r.id === 'b')?.ownerId).toBe(PICKED_WM_ID);
    expect(after.find((r) => r.id === 'b')?.ownerName).toBe('Picked Name');
    expect(after.find((r) => r.id === 'c')?.ownerId).toBe(PICKED_WM_ID);
    expect(after.find((r) => r.id === 'c')?.ownerName).toBe('Picked Name');
    // Status untouched — the bulk path is purely an ownership
    // stamp.
    for (const r of after) expect(r.status).toBe('open');
  });

  it('partial failure: envelope missing one id → that row is err, allOk=false, items untouched', async () => {
    const items = [makeRow('a'), makeRow('b')];
    const fetchImpl = vi.fn(async () =>
      assignResponse(makeEnvelope([{ id: 'a', ownerId: PICKED_WM_ID, ownerName: 'Picked Name' }])),
    );
    const result = await runBulkAssignOwner({
      items,
      selection: new Set(['a', 'b']),
      ownerId: PICKED_WM_ID,
      ownerName: 'Picked Name',
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
    const items = [makeRow('a'), makeRow('b')];
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'bad gateway' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    });
    const result = await runBulkAssignOwner({
      items,
      selection: new Set(['a', 'b']),
      ownerId: PICKED_WM_ID,
      ownerName: 'Picked Name',
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.outcomes.get('a')).toBe('err');
    expect(result.outcomes.get('b')).toBe('err');
    expect(result.allOk).toBe(false);
    expect(result.items).toBe(items);
  });

  it('schema drift: 200 envelope with non-conformant shape → all err, items untouched', async () => {
    const items = [makeRow('a')];
    const fetchImpl = vi.fn(async () => {
      return new Response('null', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const result = await runBulkAssignOwner({
      items,
      selection: new Set(['a']),
      ownerId: PICKED_WM_ID,
      ownerName: 'Picked Name',
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.outcomes.get('a')).toBe('err');
    expect(result.allOk).toBe(false);
    expect(result.items).toBe(items);
  });

  it('fetch throws (network reset) → all err, items untouched', async () => {
    const items = [makeRow('a'), makeRow('b')];
    const fetchImpl = vi.fn(async () => {
      throw new Error('network reset');
    });
    const result = await runBulkAssignOwner({
      items,
      selection: new Set(['a', 'b']),
      ownerId: PICKED_WM_ID,
      ownerName: 'Picked Name',
      fetchImpl,
    });
    expect(result.outcomes.get('a')).toBe('err');
    expect(result.outcomes.get('b')).toBe('err');
    expect(result.allOk).toBe(false);
    expect(result.items).toBe(items);
  });

  it('ownerName = null flips ownerName to null on the optimistic path', async () => {
    // The route always echoes a (server-resolved) ownerName in
    // `results[]`; the helper uses the page-resolved pair so a
    // null `ownerName` from the page surfaces as null on the
    // optimistic flip (the server's authoritative value lands
    // on the next refetch).
    const items = [makeRow('a')];
    const fetchImpl = vi.fn(async () =>
      assignResponse(makeEnvelope([{ id: 'a', ownerId: PICKED_WM_ID, ownerName: null }])),
    );
    const result = await runBulkAssignOwner({
      items,
      selection: new Set(['a']),
      ownerId: PICKED_WM_ID,
      ownerName: null,
      fetchImpl,
    });
    expect(result.allOk).toBe(true);
    const after = result.items.find((r) => r.id === 'a');
    expect(after?.ownerId).toBe(PICKED_WM_ID);
    expect(after?.ownerName).toBeNull();
  });

  it('already-owned row IS a candidate: bulk route re-stamps the FK (idempotent refresh)', async () => {
    // Critical divergence from runBulkTakeOwnership: a row whose
    // current `ownerId` equals the picked `ownerId` is NOT
    // pre-filtered. The bulk route's idempotent-refresh
    // contract means re-applying the same owner is an explicit
    // success (no churn on the column, but the row still
    // echoes in `results[]`).
    const items = [makeRow('a', PICKED_WM_ID, 'Picked Name')];
    const fetchImpl = vi.fn(async () =>
      assignResponse(makeEnvelope([{ id: 'a', ownerId: PICKED_WM_ID, ownerName: 'Picked Name' }])),
    );
    const result = await runBulkAssignOwner({
      items,
      selection: new Set(['a']),
      ownerId: PICKED_WM_ID,
      ownerName: 'Picked Name',
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.allOk).toBe(true);
    // Already-owned id is mirrored on `items` unchanged — the
    // optimistic flip is a no-op for the already-matched state
    // but the helper still stamps the page-resolved pair.
    expect(result.items.find((r) => r.id === 'a')?.ownerId).toBe(PICKED_WM_ID);
    expect(result.items.find((r) => r.id === 'a')?.ownerName).toBe('Picked Name');
  });

  it('selection ids not present in items: silently dropped (no fetch fires for unknown id)', async () => {
    // The page parses selection from the URL via
    // `parseSelectedParam` which is permissive — a stale
    // `?selected=<unknown>` should not break the helper. The
    // pre-filter narrows to `selection ∩ items`, so unknown
    // ids are silently skipped.
    const items = [makeRow('a')];
    const fetchImpl = vi.fn(async () =>
      assignResponse(makeEnvelope([{ id: 'a', ownerId: PICKED_WM_ID, ownerName: 'Picked Name' }])),
    );
    const result = await runBulkAssignOwner({
      items,
      selection: new Set(['a', 'unknown']),
      ownerId: PICKED_WM_ID,
      ownerName: 'Picked Name',
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.candidates.map((r) => r.id)).toEqual(['a']);
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.has('unknown')).toBe(false);
    expect(result.allOk).toBe(true);
  });
});
