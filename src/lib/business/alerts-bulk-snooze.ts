// @polsia:user-owned — Pure single-POST helper for the /alerts page's
// bulk "Snooze selected" gesture. Mirror of alerts-bulk-resolve.ts but
// with three behavioral deltas driven by the new bulk endpoint:
//
//   - ONE POST to /api/alerts/snooze-batch (vs. parallel fan-out over
//     /api/alerts/[id]/snooze). The new endpoint stamps the snooze
//     window in a single prisma.$transaction — atomic at the DB level.
//     A 4xx/5xx on the batch leaves every row in its pre-batch state.
//
//   - Status pre-filter drops already-`resolved` rows from the
//     candidate set — re-stamping `snoozedUntil` on a resolved row is
//     never meaningful (the row is closed; the achieved state is
//     preserved across dormant windows). Already-snoozed rows still
//     re-stamp on the bulk path (idempotent refresh) so a stale
//     snooze window can be lifted without leaving the bulk
//     affordance. Mirror of runBulkResolve's posture — the bulk-
//     snooze path takes the same dropped-resolved branch.
//
//   - Optimistic flip stamps ONLY `snoozedUntil` on every targeted id
//     on all-OK. No status flip, no `acknowledgedAt`, no
//     `statusChangedAt`. The bulk path is purely a snooze-window
//     stamp — the existing triage state on every row is preserved.
//
// Contract (what the page calls):
//   1. Candidates = `items.filter(item => selection.has(item.id) &&
//      item.status !== 'resolved')`. Already-resolved ids are
//      silently dropped — the page-side handler also pre-filters, but
//      doing it here guarantees the helper is safe to call from any
//      context (e.g. a unit test that wires a stub `fetch` and
//      expects the helper to silently skip resolved ids without
//      re-firing the route). Already-snoozed AND future-snoozed
//      rows are STILL candidates — re-applied snooze is the explicit
//      behavior on those rows.
//   2. ONE POST to /api/alerts/snooze-batch with the candidate id
//      list + either a `duration` (1d / 3d / 7d / 30d) OR a
//      client-supplied `until` ISO. The `kind` discriminator on the
//      helper input mirrors `AlertBulkSnoozeBody`'s union — the wire
//      body keeps lockstep with the helper shape so a future widening
//      cascades through a single source of truth. Per-id failure
//      (HTTP non-2xx, schema drift, or an id missing from the
//      response) becomes `'err'` on the outcome map for that id only.
//   3. Build per-id outcome map: id echoed in `results` → 'ok';
//      else → 'err'. `allOk = okCount === candidates.length`.
//   4. Optimistic flip on all-OK stamps ONLY `snoozedUntil` on every
//      targeted id (the server-echoed ISO, NOT a regenerated client
//      moment, so optimistic-flip + refetch agree 1:1); selection-
//      clearing + URL-strip happens at the page island.
//   5. Return the per-row outcomes, the post-flip items, and the
//      ids that flipped — the page applies selection-clearing +
//      toast on all-OK from these.
//
// `fetchImpl` is the single dependency seam — tests pass a stub
// that returns canned responses per url; production wires the global
// `fetch`. Keeping it injectable (instead of relying on `globalThis`)
// makes the helper portable to a server-side unit suite that has no
// window.fetch binding.

import {
  AlertBulkSnoozeBody,
  AlertBulkSnoozeResponse,
  type AlertItem,
  type SnoozeDuration,
} from '@/lib/contracts/alerts';

export type BulkRowOutcome = 'ok' | 'err';

// Snooze target — discriminated union mirroring the
// `AlertBulkSnoozeBody` schema's two arms. The `kind` discriminator
// forces every caller into one branch or the other so a hidden
// `duration` on a `target.kind === 'until'` body 500s at the type
// layer rather than silently picking whatever the JSON happens to
// carry. The candidate alert ids come from the helper's
// `items ∩ selection` pre-filter — the `target` field only carries
// the snooze-window descriptor, not the list of rows.
export type BulkSnoozeTarget =
  | { kind: 'duration'; duration: SnoozeDuration }
  | { kind: 'until'; until: string | null };

export interface BulkSnoozeInput {
  // Visible row set from /api/alerts envelope. Used both as the
  // pre-filter source AND as the optimistic-flip target on all-OK.
  items: AlertItem[];
  // The page's `selection` Set — the working set the operator built
  // up via the table/card checkboxes. Already persisted to
  // `?selected=`; this helper treats it as read-only.
  selection: Set<string>;
  // Snooze-window descriptor — the discriminated union mirroring
  // `AlertBulkSnoozeBody`:
  //   - `kind: 'duration'` — server stamps `now + WINDOW_MS[duration]`
  //     so client clock-skew never reaches the row. Mirrors the
  //     1d / 3d / 7d / 30d wire enum in `SnoozeDuration` end-to-end.
  //   - `kind: 'until'` — server echoes the supplied ISO verbatim so
  //     the operator's future pick lands exactly the chosen moment.
  //     `null` is the explicit "un-snooze" signal (writes NULL on
  //     every row); an invalid ISO 400s through the schema BEFORE
  //     this helper ever sees it.
  target: BulkSnoozeTarget;
  // Fetch-like async function. Page wires `fetch`; tests wire a stub.
  // Returns the raw Response so the helper can branch on `.ok` and
  // parse `await res.json()` exactly the way the page island does.
  fetchImpl: typeof fetch;
}

export interface BulkSnoozeResult {
  // Ids that actually fanned out against /snooze-batch. Excludes
  // the already-resolved ids the helper silently skipped (the bulk
  // route re-stamps the window on every candidate, but re-stamping
  // `snoozedUntil` on a closed row is never meaningful). Already-
  // snoozed rows are STILL candidates — re-stamping refreshes the
  // window.
  candidates: AlertItem[];
  // Per-row outcome map keyed by alert id. Missing from the map
  // means no fetch fired (empty selection).
  outcomes: Map<string, BulkRowOutcome>;
  // The post-flip row set. Equals `input.items` on partial failure;
  // mirrors the optimistic flip on all-OK. The page's setter is
  // responsible for replacing `data.items`.
  items: AlertItem[];
  // True when every candidate id POST'd and returned an envelope
  // entry. Drives the page's success toast + selection clear.
  allOk: boolean;
  // Convenience for the page's success message —
  // `1 alert snoozed.` vs `3 alerts snoozed.`
  okCount: number;
}

export async function runBulkSnooze(input: BulkSnoozeInput): Promise<BulkSnoozeResult> {
  const { items, selection, target, fetchImpl } = input;
  // (1) Pre-filter to selection ∩ non-resolved. Already-resolved
  // rows are silently dropped — re-stamping `snoozedUntil` on a
  // closed row is never meaningful. Already-snoozed rows STILL re-
  // stamp on the bulk path (idempotent refresh) so a stale snooze
  // window can be lifted without leaving the bulk affordance.
  // Mirror of the runBulkResolve posture — dropped-resolved is the
  // same shared branch. An empty selection short-circuits before
  // any fetch so the helper is safe to call from any context.
  const candidates = items.filter((item) => selection.has(item.id) && item.status !== 'resolved');
  if (candidates.length === 0) {
    return {
      candidates: [],
      outcomes: new Map(),
      items,
      allOk: true,
      okCount: 0,
    };
  }

  // Build the request body per the discriminated target. The
  // `kind` discriminator ensures a caller can never accidentally
  // carry BOTH the literal `duration` AND an `until` ISO into the
  // same body — the union forces one or the other. The route's
  // `AlertBulkSnoozeBody.safeParse` is the authoritative server-side
  // gate; .strict() on each arm rejects a body with both keys.
  const requestBody =
    target.kind === 'duration'
      ? { ids: candidates.map((c) => c.id), duration: target.duration }
      : { ids: candidates.map((c) => c.id), until: target.until };
  const safeBody = AlertBulkSnoozeBody.safeParse(requestBody);
  if (!safeBody.success) {
    // Pact-defensive — the requestBody is built from a `Set<string>`
    // armed with either a literal `duration` or a validated ISO
    // `until`, so a schema failure here is itself an invariant bug;
    // treat every candidate as 'err'.
    const outcomes = new Map<string, BulkRowOutcome>();
    for (const c of candidates) outcomes.set(c.id, 'err');
    return { candidates, outcomes, items, allOk: false, okCount: 0 };
  }

  try {
    const res = await fetchImpl('/api/alerts/snooze-batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(safeBody.data),
      cache: 'no-store',
    });
    if (!res.ok) {
      // Non-2xx — every candidate is 'err'. Items untouched.
      const outcomes = new Map<string, BulkRowOutcome>();
      for (const c of candidates) outcomes.set(c.id, 'err');
      return { candidates, outcomes, items, allOk: false, okCount: 0 };
    }
    const parsed = AlertBulkSnoozeResponse.safeParse(await res.json());
    if (!parsed.success) {
      // Schema-drift — every candidate is 'err'. Items untouched.
      const outcomes = new Map<string, BulkRowOutcome>();
      for (const c of candidates) outcomes.set(c.id, 'err');
      return { candidates, outcomes, items, allOk: false, okCount: 0 };
    }
    // Build per-id outcome map. Each id echoed in `results` → 'ok';
    // missing → 'err'. The route echoes the server-stamped ISO
    // string for the row's new `until` (server-side `now + window` on
    // the duration arm OR the echoed client ISO on the until arm) so
    // the optimistic flip can mirror it onto the page-side items.
    const stampById = new Map(parsed.data.results.map((r) => [r.id, r.snoozedUntil]));
    const outcomes = new Map<string, BulkRowOutcome>();
    let okCount = 0;
    for (const c of candidates) {
      if (stampById.has(c.id)) {
        outcomes.set(c.id, 'ok');
        okCount += 1;
      } else {
        outcomes.set(c.id, 'err');
      }
    }
    const allOk = okCount === candidates.length;
    // (5) Optimistic flip — only on all-OK. Mutates a fresh array so
    // the page can replace its `data.items` state without aliasing
    // the previous envelope. Stamps ONLY `snoozedUntil` — no status
    // flip, no `acknowledgedAt`/`statusChangedAt` writes (the bulk
    // snooze path is purely a snooze-window stamp). The new value
    // is the server-echoed ISO so optimistic-flip + a follow-up
    // refetch agree 1:1 — neither caller-drift nor server-side
    // remapping reaches the row.
    const nextItems = allOk
      ? items.map((item) => {
          if (outcomes.get(item.id) !== 'ok') return item;
          const newStamp = stampById.get(item.id) ?? item.snoozedUntil;
          return { ...item, snoozedUntil: newStamp };
        })
      : items;
    return {
      candidates,
      outcomes,
      items: nextItems,
      allOk,
      okCount,
    };
  } catch {
    // Fetch-throw (network reset, JSON parse error on non-JSON 5xx,
    // etc.) — every candidate is 'err'. Items untouched.
    const outcomes = new Map<string, BulkRowOutcome>();
    for (const c of candidates) outcomes.set(c.id, 'err');
    return { candidates, outcomes, items, allOk: false, okCount: 0 };
  }
}
