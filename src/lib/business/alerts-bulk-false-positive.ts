// @polsia:user-owned — Pure fan-out helper for the /alerts page's bulk
// "Mark selected false positive..." gesture. Mirrors the bulk-reopen
// companion (alerts-bulk-reopen.ts) but differs in two respects that
// derive from the FP write contract:
//
//   1. The FP route requires a single reason applied to N selected
//      rows (the page-side dialog collects one reason for the whole
//      fan-out — per-row prompts would be a UX anti-pattern with the
//      1–500-char reason body). The helper accepts the reason as a
//      separate named argument and POSTs the same body to every
//      selected row.
//   2. The pre-filter sub-clause differs: candidates are
//      `selection ∩ (status !== 'false_positive')` so a row that's
//      already FP is silently skipped (no fetch, no chip, no flip).
//      Matches the /false-positive route's idempotent-already-state
//      branch — a stale in-flight click on an already-FP row leaves
//      statusChangedAt untouched.
//
// Contract (what the page calls):
//   1. Pre-filter `itemsAndTargets` to rows whose id is in the
//      selection AND whose status !== 'false_positive'. Already-FP
//      ids are silently skipped — no fetch, no chip, no flip.
//   2. Fan out POSTs in parallel via Promise.allSettled against the
//      injected `fetch`. Each per-row failure (HTTP non-2xx, schema
//      drift, or an envelope that returned without status ===
//      'false_positive') becomes an 'err' entry on the outcome map.
//   3. On all-OK, mutate `data.items` so the targeted ids flip to
//      status: 'false_positive' AND stamp the supplied `reason` onto
//      the falsePositiveReason field; already-FP ids are untouched.
//   4. Return the per-row outcomes, the post-flip items, and the
//      ids that flipped — the page applies selection-clearing +
//      toast on all-OK from these.
//
// `fetchImpl` is the single dependency seam — tests pass a stub
// that returns canned responses per url; production wires the global
// `fetch`.

import { AlertFalsePositiveResponse, type AlertItem } from '@/lib/contracts/alerts';

export type BulkRowOutcome = 'ok' | 'err';

export interface BulkFalsePositiveInput {
  // Visible row set from /api/alerts envelope. Used both as the
  // pre-filter source AND as the optimistic-flip target on all-OK.
  items: AlertItem[];
  // The page's `selection` Set — the working set the operator built
  // up via the table/card checkboxes. Already persisted to
  // `?selected=`; this helper treats it as read-only.
  selection: Set<string>;
  // Single shared reason applied to every selected row. The page's
  // dialog collects it once before calling — see the comment on
  // `handleBulkFalsePositive` in the page for the UI usage.
  reason: string;
  // Fetch-like async function. Page wires `fetch`; tests wire a stub.
  fetchImpl: typeof fetch;
}

export interface BulkFalsePositiveResult {
  // Ids that actually fanned out against /false-positive. Excludes
  // the already-FP ids the helper silently skipped.
  candidates: AlertItem[];
  // Per-row outcome map keyed by alert id. Missing from the map =
  // no fetch fired (already-FP or selection-out-of-range).
  outcomes: Map<string, BulkRowOutcome>;
  // The post-flip row set. Equals `input.items` on partial failure;
  // mirrors the optimistic flip on all-OK. The page's setter is
  // responsible for replacing `data.items`.
  items: AlertItem[];
  // True when every candidate id POST'd and returned status:
  // 'false_positive'. Drives the page's success toast + selection
  // clear.
  allOk: boolean;
  // Convenience for the page's success message — `1 alert marked
  // false positive.` vs `3 alerts marked false positive.`.
  okCount: number;
}

export async function runBulkFalsePositive(
  input: BulkFalsePositiveInput,
): Promise<BulkFalsePositiveResult> {
  const { items, selection, reason, fetchImpl } = input;
  // (1) Pre-filter to selection ∩ non-FP rows. The page-side handler
  // ALSO pre-filters, but doing it here guarantees the helper is
  // safe to call from any context (e.g. a unit test that wires a
  // stub `fetch` and expects the helper to silently skip already-FP
  // ids).
  const candidates = items.filter(
    (item) => selection.has(item.id) && item.status !== 'false_positive',
  );
  if (candidates.length === 0) {
    return {
      candidates: [],
      outcomes: new Map(),
      items,
      allOk: true,
      okCount: 0,
    };
  }
  // (2) Parallel fan-out with Promise.allSettled so a single 4xx/5xx
  // can't break the whole batch (also: a reject in the fetch chain
  // must not abort the remaining `Promise.allSettled` promises).
  const settled = await Promise.allSettled(
    candidates.map(async (candidate) => {
      const res = await fetchImpl(`/api/alerts/${candidate.id}/false-positive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const parsed = AlertFalsePositiveResponse.safeParse(await res.json());
      if (!parsed.success) {
        throw new Error('schema-drift');
      }
      if (parsed.data.status !== 'false_positive') {
        throw new Error('unexpected-status');
      }
      return parsed.data;
    }),
  );
  const outcomes = new Map<string, BulkRowOutcome>();
  let okCount = 0;
  settled.forEach((result, i) => {
    const id = candidates[i]?.id;
    if (!id) return;
    if (result.status === 'fulfilled') {
      outcomes.set(id, 'ok');
      okCount += 1;
    } else {
      outcomes.set(id, 'err');
    }
  });
  const allOk = okCount === candidates.length;
  // (3) Optimistic flip — only on all-OK. Mutates a fresh array so
  // the page can replace its `data.items` state without aliasing the
  // previous envelope. The stamp writes both the status flip AND
  // the reason so a single setState replaces the chip and its
  // subtitle atomically.
  const nextItems = allOk
    ? items.map((item) =>
        outcomes.get(item.id) === 'ok'
          ? { ...item, status: 'false_positive' as const, falsePositiveReason: reason }
          : item,
      )
    : items;
  return {
    candidates,
    outcomes,
    items: nextItems,
    allOk,
    okCount,
  };
}
