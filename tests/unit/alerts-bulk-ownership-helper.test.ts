// Pure-TS contract tests for the /alerts page's bulk "Take
// ownership" helper (`runBulkTakeOwnership`). Mirrors the
// bulk-remediate test suite's posture — helper-level scenarios
// stub-fake `fetch` and verify the contract:
//
//   1. `ownerId !== callerWorkspaceMemberId` pre-filter —
//      already-owned rows are SILENTLY DROPPED (the bulk route's
//      per-id already-owned branch surfaces them via the
//      `conflicts[]` envelope arm, but the helper pre-filter saves
//      the round trip on obvious takes).
//   2. ONE POST to /api/alerts/ownership-batch with `{ids}` —
//      no `ownerId` (the assignment target is the caller
//      WorkspaceMember resolved server-side). Per-row failure
//      (HTTP non-2xx, schema drift, or an id missing from BOTH
//      `results` AND `conflicts`) becomes 'err' on the outcome map.
//   3. All-OK optimistic flip stamps BOTH `ownerId`
//      (= callerWorkspaceMemberId, server-authoritative) AND
//      `ownerName` (= callerName ?? null) — no status flip, no
//      acknowledgedAt writes.
//   4. Empty selection (or fully-owned selection) → silent no-op.
//   5. `callerWorkspaceMemberId = null` → silent no-op (the route
//      would 404 anyway on a missing roster row).
//   6. Already-owned branch paints `'ok'` (NOT `'err'`) when the
//      route surfaces a stale post-mount reassignment through the
//      `conflicts[]` envelope arm — the page's success toast
//      composes from `conflictCount` to distinguish "taken" from
//      "already owned".

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { describe, expect, it, vi } from 'vitest';
import { runBulkTakeOwnership } from '@/lib/business/alerts-bulk-ownership';
import type { AlertItem } from '@/lib/contracts/alerts';

const CALLER_WM_ID = 'wm-caller';
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
  };
}

function makeEnvelope(
  results: Array<{ id: string; ownerId: string; ownerName: string | null }>,
  conflicts: Array<{ id: string; ownerId: string }> = [],
) {
  return { results, conflicts };
}

function ownershipResponse(envelope: unknown, status = 200): Response {
  return new Response(JSON.stringify(envelope), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('runBulkTakeOwnership — contract scenarios', () => {
  it('empty selection → silent no-op, no fetches fired, items unchanged', async () => {
    const items = [makeRow('a'), makeRow('b')];
    const fetchImpl = vi.fn();
    const result = await runBulkTakeOwnership({
      items,
      selection: new Set(),
      callerWorkspaceMemberId: CALLER_WM_ID,
      callerName: 'Caller Name',
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
    expect(result.outcomes.size).toBe(0);
    expect(result.allOk).toBe(true);
    expect(result.okCount).toBe(0);
    expect(result.conflictCount).toBe(0);
    expect(result.items).toBe(items);
  });

  it('happy path: 3 unowned rows → ONE POST with {ids}, optimistic flip stamps BOTH ownerId + ownerName', async () => {
    const items = [makeRow('a', OTHER_WM_ID), makeRow('b', OTHER_WM_ID), makeRow('c', OTHER_WM_ID)];
    const selection = new Set(['a', 'b', 'c']);
    const captured: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      captured.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      return ownershipResponse(
        makeEnvelope([
          { id: 'a', ownerId: CALLER_WM_ID, ownerName: 'Caller Name' },
          { id: 'b', ownerId: CALLER_WM_ID, ownerName: 'Caller Name' },
          { id: 'c', ownerId: CALLER_WM_ID, ownerName: 'Caller Name' },
        ]),
      );
    });
    const result = await runBulkTakeOwnership({
      items,
      selection,
      callerWorkspaceMemberId: CALLER_WM_ID,
      callerName: 'Caller Name',
      fetchImpl,
    });
    // ONE fetch — the new endpoint stamps per-id.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(captured[0]?.url).toBe('/api/alerts/ownership-batch');
    expect(captured[0]?.body).toEqual({ ids: ['a', 'b', 'c'] });
    // No `ownerId` / no `name` on the body — the assignment
    // target is the server-resolved caller WorkspaceMember.
    expect(Object.keys((captured[0]?.body ?? {}) as Record<string, unknown>)).toEqual(['ids']);
    expect(result.candidates.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.get('b')).toBe('ok');
    expect(result.outcomes.get('c')).toBe('ok');
    expect(result.allOk).toBe(true);
    expect(result.okCount).toBe(3);
    expect(result.conflictCount).toBe(0);
    // Every targeted id picked up BOTH the new ownerId AND the
    // caller name on the optimistic flip.
    const after = result.items;
    expect(after.find((r) => r.id === 'a')?.ownerId).toBe(CALLER_WM_ID);
    expect(after.find((r) => r.id === 'a')?.ownerName).toBe('Caller Name');
    expect(after.find((r) => r.id === 'b')?.ownerId).toBe(CALLER_WM_ID);
    expect(after.find((r) => r.id === 'b')?.ownerName).toBe('Caller Name');
    expect(after.find((r) => r.id === 'c')?.ownerId).toBe(CALLER_WM_ID);
    expect(after.find((r) => r.id === 'c')?.ownerName).toBe('Caller Name');
    // Status untouched — the bulk path is purely an ownership
    // stamp.
    for (const r of after) expect(r.status).toBe('open');
  });

  it('already-owned row is NOT a candidate: pre-filter drops it before the fetch', async () => {
    // The bulk route's already-owned branch surfaces via the
    // `conflicts[]` envelope arm (NOT an UPDATE), but the helper
    // pre-filter saves the round trip on obvious takes — the
    // page mirrors this filter for the `pending` indicator-strip
    // seed.
    const items = [makeRow('a', CALLER_WM_ID, 'Caller Name')];
    const fetchImpl = vi.fn();
    const result = await runBulkTakeOwnership({
      items,
      selection: new Set(['a']),
      callerWorkspaceMemberId: CALLER_WM_ID,
      callerName: 'Caller Name',
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
    expect(result.outcomes.size).toBe(0);
    expect(result.allOk).toBe(true);
    expect(result.items).toBe(items);
  });

  it('selection is only already-owned rows → no fetch fires (helper short-circuits)', async () => {
    // Every selected row is already owned by the caller; the
    // helper's pre-filter drops them all. The route would
    // surface these via the `conflicts[]` envelope arm if a
    // stale post-mount reassignment ever sent them over the
    // wire, but they never reach the wire here.
    const items = [
      makeRow('a', CALLER_WM_ID, 'Caller Name'),
      makeRow('b', CALLER_WM_ID, 'Caller Name'),
    ];
    const fetchImpl = vi.fn();
    const result = await runBulkTakeOwnership({
      items,
      selection: new Set(['a', 'b']),
      callerWorkspaceMemberId: CALLER_WM_ID,
      callerName: 'Caller Name',
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
    expect(result.outcomes.size).toBe(0);
    expect(result.allOk).toBe(true);
    expect(result.okCount).toBe(0);
    expect(result.conflictCount).toBe(0);
    expect(result.items).toBe(items);
  });

  it('callerWorkspaceMemberId = null → silent no-op (route would 404 anyway)', async () => {
    // A null caller id means the caller is not an active team
    // member — a fetch the route would 404 is worse than a
    // quiet no-op. The page's submit handler pre-gates on the
    // same null-id; the helper's defensive null-id short-circuit
    // is intentional parity.
    const items = [makeRow('a', OTHER_WM_ID)];
    const fetchImpl = vi.fn();
    const result = await runBulkTakeOwnership({
      items,
      selection: new Set(['a']),
      callerWorkspaceMemberId: null,
      callerName: null,
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
    expect(result.outcomes.size).toBe(0);
    expect(result.allOk).toBe(true);
    expect(result.items).toBe(items);
  });

  it('partial: mixed results+conflicts envelope → every id is "ok" without failure', async () => {
    // Brief's "without failure" stance: an id the route reports
    // via `conflicts[]` is STILL 'ok' on the outcome map
    // (already-owned rows are reported as a no-op success, NOT
    // a failure). `conflictCount` distinguishes them so the page
    // composes the success toast from both totals.
    const items = [makeRow('a', OTHER_WM_ID), makeRow('b', OTHER_WM_ID)];
    const fetchImpl = vi.fn(async () =>
      ownershipResponse(
        makeEnvelope(
          [{ id: 'a', ownerId: CALLER_WM_ID, ownerName: 'Caller Name' }],
          [{ id: 'b', ownerId: CALLER_WM_ID }],
        ),
      ),
    );
    const result = await runBulkTakeOwnership({
      items,
      selection: new Set(['a', 'b']),
      callerWorkspaceMemberId: CALLER_WM_ID,
      callerName: 'Caller Name',
      fetchImpl,
    });
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.get('b')).toBe('ok');
    expect(result.allOk).toBe(true);
    expect(result.okCount).toBe(2);
    expect(result.conflictCount).toBe(1);
    // Optimistic flip still fires on the all-OK arm — both
    // selected ids stamped to the caller.
    const after = result.items;
    expect(after.find((r) => r.id === 'a')?.ownerId).toBe(CALLER_WM_ID);
    expect(after.find((r) => r.id === 'b')?.ownerId).toBe(CALLER_WM_ID);
  });

  it('callerName = null flips ownerName to null on the optimistic path', async () => {
    // Optimistic flip stamps null when the caller name is
    // unknown; the server still stamps its authoritative value
    // (via the per-id UPDATE — server stamps `User.name` once at
    // the top of the route).
    const items = [makeRow('a', OTHER_WM_ID)];
    const fetchImpl = vi.fn(async () =>
      ownershipResponse(makeEnvelope([{ id: 'a', ownerId: CALLER_WM_ID, ownerName: null }])),
    );
    const result = await runBulkTakeOwnership({
      items,
      selection: new Set(['a']),
      callerWorkspaceMemberId: CALLER_WM_ID,
      callerName: null,
      fetchImpl,
    });
    expect(result.allOk).toBe(true);
    const after = result.items.find((r) => r.id === 'a');
    expect(after?.ownerId).toBe(CALLER_WM_ID);
    expect(after?.ownerName).toBeNull();
  });

  it('non-2xx response: every candidate is err, items untouched', async () => {
    const items = [makeRow('a', OTHER_WM_ID), makeRow('b', OTHER_WM_ID)];
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'bad gateway' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    });
    const result = await runBulkTakeOwnership({
      items,
      selection: new Set(['a', 'b']),
      callerWorkspaceMemberId: CALLER_WM_ID,
      callerName: 'Caller Name',
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.outcomes.get('a')).toBe('err');
    expect(result.outcomes.get('b')).toBe('err');
    expect(result.allOk).toBe(false);
    expect(result.okCount).toBe(0);
    expect(result.conflictCount).toBe(0);
    expect(result.items).toBe(items);
  });

  it('schema drift: 200 envelope with wrong shape → every candidate is err', async () => {
    const items = [makeRow('a', OTHER_WM_ID)];
    const fetchImpl = vi.fn(async () => {
      return new Response('null', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const result = await runBulkTakeOwnership({
      items,
      selection: new Set(['a']),
      callerWorkspaceMemberId: CALLER_WM_ID,
      callerName: 'Caller Name',
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.outcomes.get('a')).toBe('err');
    expect(result.allOk).toBe(false);
    expect(result.items).toBe(items);
  });

  it('id missing from BOTH results AND conflicts → that candidate is err', async () => {
    // Mirror the snooze helper's posture: an id that the route
    // silently dropped (e.g. cross-team) is missing from both
    // `results` and `conflicts` — the helper still paints 'err'
    // so the page's bar surfaces a meaningful partial-failure
    // toast.
    const items = [makeRow('a', OTHER_WM_ID), makeRow('b', OTHER_WM_ID)];
    const fetchImpl = vi.fn(async () =>
      ownershipResponse(
        makeEnvelope([{ id: 'a', ownerId: CALLER_WM_ID, ownerName: 'Caller Name' }]),
      ),
    );
    const result = await runBulkTakeOwnership({
      items,
      selection: new Set(['a', 'b']),
      callerWorkspaceMemberId: CALLER_WM_ID,
      callerName: 'Caller Name',
      fetchImpl,
    });
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.get('b')).toBe('err');
    expect(result.allOk).toBe(false);
    expect(result.okCount).toBe(1);
    expect(result.conflictCount).toBe(0);
    expect(result.items).toBe(items);
  });

  it('fetch throws (network reset) → every candidate is err, items untouched', async () => {
    const items = [makeRow('a', OTHER_WM_ID), makeRow('b', OTHER_WM_ID)];
    const fetchImpl = vi.fn(async () => {
      throw new Error('network reset');
    });
    const result = await runBulkTakeOwnership({
      items,
      selection: new Set(['a', 'b']),
      callerWorkspaceMemberId: CALLER_WM_ID,
      callerName: 'Caller Name',
      fetchImpl,
    });
    expect(result.outcomes.get('a')).toBe('err');
    expect(result.outcomes.get('b')).toBe('err');
    expect(result.allOk).toBe(false);
    expect(result.items).toBe(items);
  });

  it('selection ids not present in items: silently dropped (no fetch fires for unknown id)', async () => {
    // The page parses selection from the URL via
    // `parseSelectedParam` which is permissive — a stale
    // `?selected=<unknown>` should not break the helper. The
    // pre-filter narrows to `selection ∩ items ∩ (item.ownerId
    // !== callerWorkspaceMemberId)`, so unknown ids are silently
    // skipped.
    const items = [makeRow('a', OTHER_WM_ID)];
    const fetchImpl = vi.fn(async () =>
      ownershipResponse(
        makeEnvelope([{ id: 'a', ownerId: CALLER_WM_ID, ownerName: 'Caller Name' }]),
      ),
    );
    const result = await runBulkTakeOwnership({
      items,
      selection: new Set(['a', 'unknown']),
      callerWorkspaceMemberId: CALLER_WM_ID,
      callerName: 'Caller Name',
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.candidates.map((r) => r.id)).toEqual(['a']);
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.has('unknown')).toBe(false);
    expect(result.allOk).toBe(true);
  });
});
