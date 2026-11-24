// @polsia:user-owned — Pure fan-out helper for the /alerts page's bulk
// "Reopen selected" gesture. Mirrors the bulk-resolve companion (see
// the inline pattern in src/app/(dashboard)/alerts/page.tsx) but is
// extracted here so the four contract scenarios — happy path, role
// gate, idempotent no-op, mixed selection — can be unit-tested against
// a stubbed `fetch` without booting next/navigation, sonner, or the
// full page island.
//
// Why a side-effect-bounded helper instead of an inline closure on
// the page:
//   - The page's handleBulkReopen captures a lot of React state that
//     would force the unit test to mock the whole tree (router,
//     searchParams, apiFetch, toaster). The handler body is pure
//     otherwise: given the working set, the visible items, a fetch,
//     and an optional reason, it produces (a) the list of ids to fan
//     out against, (b) the per-row outcome map, (c) the post-flip
//     items array, and (d) the success/allOk signal that drives the
//     page's toast. Pulling those out makes the scenarios direct
//     function-level assertions.
//   - The page island consumes this helper through runBulkReopen()
//     and keeps the React state wiring on the page side. The helper
//     never imports React, sonner, @/lib/db, or next/navigation.
//
// Contract (what the page calls):
//   1. Pre-filter `itemsAndTargets` to rows whose id is in the
//      selection AND whose status === 'resolved'. Already-open ids
//      are silently skipped — no fetch, no chip, no flip. Matches the
//      /reopen route's idempotent-already-open branch so a stale
//      click never churns statusChangedAt.
//   2. Fan out POSTs in parallel via Promise.allSettled against the
//      injected `fetch`. Each per-row failure (HTTP non-2xx, schema
//      drift, or an envelope that returned without status === 'open')
//      becomes an 'err' entry on the outcome map. The body POSTed
//      mirrors `AlertReopenBody`: `{reason: trimmedReason}` when the
//      caller supplied a non-blank reason, bare `{}` otherwise —
//      parity with the FP companion's named-arg shape but with the
//      `reason` OPTIONAL rather than required.
//   3. On all-OK, mutate `data.items` so the targeted ids flip to
//      status: 'open'; already-open ids are untouched.
//   4. Return the per-row outcomes, the post-flip items, and the
//      ids that flipped — the page applies selection-clearing +
//      toast on all-OK from these.
//
// `fetchImpl` is the single dependency seam — tests pass a stub
// that returns canned responses per url; production wires the global
// `fetch`. Keeping it injectable (instead of relying on `globalThis`)
// makes the helper portable to a server-side unit suite that has no
// window.fetch binding.

import { type AlertItem, AlertResolveResponse } from '@/lib/contracts/alerts';

export type BulkRowOutcome = 'ok' | 'err';

export interface BulkReopenInput {
  // Visible row set from /api/alerts envelope. Used both as the
  // pre-filter source AND as the optimistic-flip target on all-OK.
  items: AlertItem[];
  // The page's `selection` Set — the working set the operator built
  // up via the table/card checkboxes. Already persisted to
  // `?selected=`; this helper treats it as read-only.
  selection: Set<string>;
  // Optional shared reason applied to every selected row. Mirrors
  // the FP helper's named-arg shape (`reason` is a separate named
  // parameter) but with `reason` OPTIONAL — a blank bulk reopen
  // sends `{}` to every row, while a non-empty bulk reopen sends
  // `{reason: trimmedReason}` so the route can stamp the shared
  // note onto every reopen trio. Trimmed here on the helper side
  // (NOT the route — the route receives the post-trim string).
  // When `reason.trim()` is zero length, the body sent is `{}`;
  // when non-empty, the body sent is `{reason: trimmed}`.
  reason?: string;
  // Fetch-like async function. Page wires `fetch`; tests wire a stub.
  // Returns the raw Response so the helper can branch on `.ok` and
  // parse `await res.json()` exactly the way the page island does.
  fetchImpl: typeof fetch;
}

export interface BulkReopenResult {
  // Ids that actually fanned out against /reopen. Excludes the
  // already-open ids the helper silently skipped.
  candidates: AlertItem[];
  // Per-row outcome map keyed by alert id. Missing from the map =
  // no fetch fired (already-open or selection-out-of-range).
  outcomes: Map<string, BulkRowOutcome>;
  // The post-flip row set. Equals `input.items` on partial failure;
  // mirrors the optimistic flip on all-OK. The page's setter is
  // responsible for replacing `data.items`.
  items: AlertItem[];
  // True when every candidate id POST'd and returned status: 'open'.
  // Drives the page's success toast + selection clear.
  allOk: boolean;
  // Convenience for the page's success message — `1 alert reopened.`
  // vs `3 alerts reopened.`.
  okCount: number;
}

export async function runBulkReopen(input: BulkReopenInput): Promise<BulkReopenResult> {
  const { items, selection, reason, fetchImpl } = input;
  // Trim the shared reason UP FRONT so the POST body shape is
  // deterministic across the bulk fan-out. A blank/whitespace-only
  // reason collapses to the bare `{}` body so the route stamps
  // `reopenReason: null` on every row (parity with the single-
  // row path's whitespace handling).
  const trimmedReason = (reason ?? '').trim();
  const body = trimmedReason.length > 0 ? { reason: trimmedReason } : ({} as const);

  // (1) Pre-filter to resolved-in-targets.
  const candidates = items.filter((item) => selection.has(item.id) && item.status === 'resolved');
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
      const res = await fetchImpl(`/api/alerts/${candidate.id}/reopen`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // POST the trimmed reason when non-blank; bare `{}`
        // otherwise — the route stamps NULL on the blank branch
        // and the (trimmed) value on the non-blank branch.
        body: JSON.stringify(body),
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const parsed = AlertResolveResponse.safeParse(await res.json());
      if (!parsed.success) {
        throw new Error('schema-drift');
      }
      if (parsed.data.status !== 'open') {
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
  // previous envelope.
  const nextItems = allOk
    ? items.map((item) =>
        outcomes.get(item.id) === 'ok' ? { ...item, status: 'open' as const } : item,
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
