// Pure-TS contract tests for the /alerts page's bulk "Mark
// remediated" helper (`runBulkRemediate`). Mirrors the bulk-snooze
// test suite's posture — helper-level scenarios stub-fake `fetch`
// and verify the contract:
//
//   1. `remediatedAt === null` pre-filter — already-remediated rows
//      are silently dropped (the bulk route's idempotent branch
//      preserves the original stamp, but the helper pre-filter
//      saves the round trip on obviously-stamped rows).
//   2. ONE POST to /api/alerts/remediate-batch with `{ids}` —
//      no `duration`, no `set`. Per-row failure (HTTP non-2xx,
//      schema drift, an id missing from `results`, or an id
//      echoed in `failed`) becomes 'err' on the outcome map for
//      that id only.
//   3. All-OK optimistic flip stamps BOTH `remediatedAt` (ISO
//      from server envelope) AND `remediatedByEmail` (from
//      `callerEmail` arg) — no status flip, no acknowledgedAt /
//      statusChangedAt writes.
//   4. Empty selection (or fully-stamped selection) → silent no-op.
//   5. `callerEmail = null` flips `remediatedByEmail` to `null` on
//      the optimistic path; the server still stamps its
//      authoritative value.

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { describe, expect, it, vi } from 'vitest';
import { runBulkRemediate } from '@/lib/business/alerts-bulk-remediate';
import type { AlertItem } from '@/lib/contracts/alerts';

function makeRow(
  id: string,
  status: 'open' | 'in_progress' | 'resolved' | 'false_positive',
  remediatedAt: string | null = null,
): AlertItem {
  return {
    id,
    teamId: 'team-1',
    findingId: `f-${id}`,
    severity: 'high',
    status,
    source: 'kev',
    assigneeId: null,
    ownerId: 'wm-1',
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
    remediatedAt,
    remediatedByEmail: null,
  };
}

function makeBulkEnvelope(
  ids: string[],
  stampIso: string,
  failed: Array<{ id: string; error: 'not_owner' }> = [],
) {
  return {
    results: ids.map((id) => ({ id, remediatedAt: stampIso })),
    failed,
  };
}

function bulkResponse(envelope: unknown, status = 200): Response {
  return new Response(JSON.stringify(envelope), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('runBulkRemediate — contract scenarios', () => {
  it('empty selection → silent no-op, no fetches fired, items unchanged', async () => {
    const items = [makeRow('a', 'open'), makeRow('b', 'resolved')];
    const fetchImpl = vi.fn();
    const result = await runBulkRemediate({
      items,
      selection: new Set(),
      callerEmail: 'me@example.com',
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
    expect(result.outcomes.size).toBe(0);
    expect(result.allOk).toBe(true);
    expect(result.okCount).toBe(0);
    expect(result.items).toBe(items);
  });

  it('happy path: 3 selected unremediated rows → ONE POST with {ids}, optimistic flip stamps BOTH remediatedAt and remediatedByEmail', async () => {
    const items = [makeRow('a', 'open'), makeRow('b', 'open'), makeRow('c', 'open')];
    const selection = new Set(['a', 'b', 'c']);
    const STAMP_NOW = new Date().toISOString();
    const captured: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      captured.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      return bulkResponse(makeBulkEnvelope(['a', 'b', 'c'], STAMP_NOW));
    });
    const result = await runBulkRemediate({
      items,
      selection,
      callerEmail: 'me@example.com',
      fetchImpl,
    });
    // ONE fetch — the new endpoint stamps per-id.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(captured[0]?.url).toBe('/api/alerts/remediate-batch');
    expect(captured[0]?.body).toEqual({ ids: ['a', 'b', 'c'] });
    // No `duration` / no `set` / no extras on the body.
    expect(Object.keys((captured[0]?.body ?? {}) as Record<string, unknown>)).toEqual(['ids']);
    expect(result.candidates.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.get('b')).toBe('ok');
    expect(result.outcomes.get('c')).toBe('ok');
    expect(result.allOk).toBe(true);
    expect(result.okCount).toBe(3);
    // Every targeted id picked up BOTH the new remediatedAt AND
    // the caller email on the optimistic flip.
    const after = result.items;
    expect(after.find((r) => r.id === 'a')?.remediatedAt).toBe(STAMP_NOW);
    expect(after.find((r) => r.id === 'a')?.remediatedByEmail).toBe('me@example.com');
    expect(after.find((r) => r.id === 'b')?.remediatedAt).toBe(STAMP_NOW);
    expect(after.find((r) => r.id === 'b')?.remediatedByEmail).toBe('me@example.com');
    expect(after.find((r) => r.id === 'c')?.remediatedAt).toBe(STAMP_NOW);
    expect(after.find((r) => r.id === 'c')?.remediatedByEmail).toBe('me@example.com');
    // Status untouched — the bulk path is purely a remediation stamp.
    for (const r of after) expect(r.status).toBe('open');
  });

  it('already-remediated row is NOT a candidate: pre-filter drops it before the fetch', async () => {
    // The bulk route's idempotent branch preserves the original
    // stamp anyway, but the helper's pre-filter saves the round
    // trip on obvious-stamp rows. The page mirrors this filter for
    // the `pending` indicator-strip seed.
    const EARLIER = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const items = [makeRow('a', 'open', EARLIER)];
    const fetchImpl = vi.fn();
    const result = await runBulkRemediate({
      items,
      selection: new Set(['a']),
      callerEmail: 'me@example.com',
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
    expect(result.outcomes.size).toBe(0);
    expect(result.allOk).toBe(true);
    expect(result.items).toBe(items);
  });

  it('callerEmail = null flips remediatedByEmail to null on the optimistic path', async () => {
    const items = [makeRow('a', 'open')];
    const selection = new Set(['a']);
    const STAMP_NOW = new Date().toISOString();
    const fetchImpl = vi.fn(async () => bulkResponse(makeBulkEnvelope(['a'], STAMP_NOW)));
    const result = await runBulkRemediate({
      items,
      selection,
      callerEmail: null,
      fetchImpl,
    });
    expect(result.allOk).toBe(true);
    const after = result.items.find((r) => r.id === 'a');
    // Optimistic flip stamps null when the caller email is unknown.
    expect(after?.remediatedAt).toBe(STAMP_NOW);
    expect(after?.remediatedByEmail).toBeNull();
  });

  it('partial failure from "failed" envelope: not_owner rows are err', async () => {
    // The bulk route surfaces a per-id owner rejection via the
    // `failed[]` arm of the response envelope. The helper's
    // outcome map paints those ids 'err' even on a 200 response so
    // the bar surfaces a meaningful partial-failure toast.
    const items = [makeRow('a', 'open'), makeRow('b', 'open')];
    const STAMP_NOW = new Date().toISOString();
    const fetchImpl = vi.fn(async () =>
      bulkResponse(makeBulkEnvelope(['a'], STAMP_NOW, [{ id: 'b', error: 'not_owner' }])),
    );
    const result = await runBulkRemediate({
      items,
      selection: new Set(['a', 'b']),
      callerEmail: 'me@example.com',
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

  it('partial failure: envelope missing one id (no failed entry) → that row is err', async () => {
    // Mirror the snooze helper's posture: an id that the route
    // silently dropped (e.g. cross-team) is missing from both
    // `results` and `failed` — the helper still paints 'err' so
    // the page's bar surfaces a meaningful partial-failure toast.
    const items = [makeRow('a', 'open'), makeRow('b', 'open')];
    const STAMP_NOW = new Date().toISOString();
    const fetchImpl = vi.fn(async () => bulkResponse(makeBulkEnvelope(['a'], STAMP_NOW)));
    const result = await runBulkRemediate({
      items,
      selection: new Set(['a', 'b']),
      callerEmail: 'me@example.com',
      fetchImpl,
    });
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.get('b')).toBe('err');
    expect(result.allOk).toBe(false);
    expect(result.okCount).toBe(1);
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
    const result = await runBulkRemediate({
      items,
      selection: new Set(['a', 'b']),
      callerEmail: 'me@example.com',
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
    const result = await runBulkRemediate({
      items,
      selection: new Set(['a']),
      callerEmail: 'me@example.com',
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
    const result = await runBulkRemediate({
      items,
      selection: new Set(['a', 'b']),
      callerEmail: 'me@example.com',
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
    // items ∩ (item.remediatedAt === null)`, so unknown ids are
    // silently skipped.
    const items = [makeRow('a', 'open')];
    const STAMP_NOW = new Date().toISOString();
    const fetchImpl = vi.fn(async () => bulkResponse(makeBulkEnvelope(['a'], STAMP_NOW)));
    const result = await runBulkRemediate({
      items,
      selection: new Set(['a', 'unknown']),
      callerEmail: 'me@example.com',
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.candidates.map((r) => r.id)).toEqual(['a']);
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.has('unknown')).toBe(false);
    expect(result.allOk).toBe(true);
  });
});
