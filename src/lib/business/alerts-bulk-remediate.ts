// @polsia:user-owned — Pure single-POST helper for the /alerts page's
// bulk "Mark remediated" gesture. Mirror of alerts-bulk-snooze.ts but
// with three keyed behavioral deltas driven by the new bulk endpoint:
//
//   - ONE POST to /api/alerts/remediate-batch (vs. parallel fan-out
//     over /api/alerts/[id]/remediate). The new endpoint writes per-id
//     (NOT atomic across the batch) so an owner-mismatch on row N does
//     NOT paper-over rows M ≠ N — instead, the response surfaces the
//     per-id failure into a `failed[]` envelope and the rest of the
//     batch stamps cleanly. Per-id fan-out via Promise.allSettled
//     (the single-id route posture) is also rejected because the
//     brief explicitly mandates "per-id transactions".
//
//   - `remediatedAt === null` pre-filter — already-remediated rows
//     are silently dropped from the candidate set. The bulk route
//     does NOT stamp a churn value back over an existing stamp
//     (the route's idempotent-already-stamped branch returns the
//     existing envelope without an UPDATE — preserving the original
//     audit trace), and the helper's pre-filter short-circuits the
//     network round trip for obviously-stamped rows. The page
//     mirrors this filter for the `pending` indicator-strip seed.
//
//   - Optimistic flip on all-OK stamps BOTH `remediatedAt` (ISO from
//     the server envelope) AND `remediatedByEmail` (from
//     `input.callerEmail`). The helper signature gains a
//     `callerEmail: string | null` so the page can pass
//     `session?.user?.email` (the optimistic flip degrades to "stamp
//     remediation time only" when the email is unknown; the server
//     route stamps its authoritative value from
//     `WorkspaceMember.email ?? ctx.user.email`).
//
// Contract (what the page calls):
//   1. Candidates = `items.filter(item => selection.has(item.id) AND
//      item.remediatedAt === null)`. Already-stamped rows are
//      SILENTLY DROPPED (the brief's "rows that already have a
//      stamp aren't valid candidates"; the helper pre-filter saves
//      the network round trip on obviously-stamped rows).
//   2. ONE POST to /api/alerts/remediate-batch with the candidate id
//      list (no `duration`, no `set` — the bulk action is a unit-less
//      "stamp now"). Per-id failure (HTTP non-2xx, schema drift, an
//      id missing from `results`, or an id echoed in `failed`) becomes
//      `'err'` on the outcome map for that id only.
//   3. Build per-id outcome map: id echoed in `results` → 'ok';
//      else → 'err'. `allOk = okCount === candidates.length`.
//   4. Optimistic flip on all-OK stamps BOTH `remediatedAt` (ISO
//      from server envelope) AND `remediatedByEmail` (from
//      `input.callerEmail`) onto the targeted items. Out-of-band
//      IDs missing from `items` are untouched.
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
  AlertBulkRemediateBody,
  AlertBulkRemediateResponse,
  type AlertItem,
} from '@/lib/contracts/alerts';

export type BulkRowOutcome = 'ok' | 'err';

export interface BulkRemediateInput {
  // Visible row set from /api/alerts envelope. Used both as the
  // pre-filter source AND as the optimistic-flip target on all-OK.
  items: AlertItem[];
  // The page's `selection` Set — the working set the operator built
  // up via the table/card checkboxes. Already persisted to
  // `?selected=`; this helper treats it as read-only.
  selection: Set<string>;
  // Caller's email, used to seed the optimistic flip's
  // `remediatedByEmail` value. Server-authoritative stamp lives on
  // `WorkspaceMember.email ?? User.email` (the route peer-reads both
  // rows); the helper's value degrades to "stamp remediation time
  // only" when null. Pass `session?.user?.email ?? null`.
  callerEmail: string | null;
  // Fetch-like async function. Page wires `fetch`; tests wire a stub.
  // Returns the raw Response so the helper can branch on `.ok` and
  // parse `await res.json()` exactly the way the page island does.
  fetchImpl: typeof fetch;
}

export interface BulkRemediateResult {
  // Ids that actually fanned out against /remediate-batch. Excludes
  // already-remediated rows by helper-side pre-filter (the bulk route
  // would short-circuit them on its idempotent branch, but the
  // pre-filter saves the round trip).
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
  // `1 alert remediated.` vs `3 alerts remediated.`
  okCount: number;
}

export async function runBulkRemediate(input: BulkRemediateInput): Promise<BulkRemediateResult> {
  const { items, selection, callerEmail, fetchImpl } = input;
  // (1) Pre-filter to selection AND already-not-stamped. The bulk
  // route's idempotent branch is a no-op envelope for already-
  // stamped rows — saving the round trip on the page side short-
  // circuits the wire for obvious cases. An empty pre-filter short-
  // circuits before any fetch so the helper is safe to call from
  // any context.
  const candidates = items.filter((item) => selection.has(item.id) && item.remediatedAt === null);
  if (candidates.length === 0) {
    return {
      candidates: [],
      outcomes: new Map(),
      items,
      allOk: true,
      okCount: 0,
    };
  }

  // Defensive parse against the route's wire shape so a future drift
  // between helper and route surfaces inside the helper at runtime
  // (the route's zod schema is the authoritative server-side gate).
  const requestBody = { ids: candidates.map((c) => c.id) };
  const safeBody = AlertBulkRemediateBody.safeParse(requestBody);
  if (!safeBody.success) {
    // Pact-defensive — the requestBody is built from a `Set<string>`
    // so the schema failure here is itself an invariant bug; treat
    // every candidate as 'err'.
    const outcomes = new Map<string, BulkRowOutcome>();
    for (const c of candidates) outcomes.set(c.id, 'err');
    return { candidates, outcomes, items, allOk: false, okCount: 0 };
  }

  try {
    const res = await fetchImpl('/api/alerts/remediate-batch', {
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
    const parsed = AlertBulkRemediateResponse.safeParse(await res.json());
    if (!parsed.success) {
      // Schema-drift — every candidate is 'err'. Items untouched.
      const outcomes = new Map<string, BulkRowOutcome>();
      for (const c of candidates) outcomes.set(c.id, 'err');
      return { candidates, outcomes, items, allOk: false, okCount: 0 };
    }
    // Build per-id outcome map. Each id echoed in `results` → 'ok';
    // missing OR echoed in `failed` (the per-id owner-gate
    // rejection, surfaced as a typed envelope) → 'err'. The route
    // echoes the server-stamped ISO string for the row's new
    // `remediatedAt` so the optimistic flip can mirror it onto the
    // page-side items.
    const stampById = new Map(parsed.data.results.map((r) => [r.id, r.remediatedAt]));
    const failedIds = new Set(parsed.data.failed.map((f) => f.id));
    const outcomes = new Map<string, BulkRowOutcome>();
    let okCount = 0;
    for (const c of candidates) {
      if (stampById.has(c.id) && !failedIds.has(c.id)) {
        outcomes.set(c.id, 'ok');
        okCount += 1;
      } else {
        outcomes.set(c.id, 'err');
      }
    }
    const allOk = okCount === candidates.length;

    // (5) Optimistic flip — only on all-OK. Mutates a fresh array so
    // the page can replace its `data.items` state without aliasing
    // the previous envelope. Stamps BOTH `remediatedAt` (ISO from
    // the server envelope — server is the authoritative timestamp
    // source) AND `remediatedByEmail` (from `input.callerEmail` —
    // deviates from the Snooze helper, which only touches
    // `snoozedUntil`, because the wire shape for the remediate
    // bulk envelope deliberately omits `remediatedByEmail` to stay
    // narrow and the optimistic UI mirrors the caller-known email
    // onto the chip subtitle without a second round trip).
    const nextItems = allOk
      ? items.map((item) => {
          if (outcomes.get(item.id) !== 'ok') return item;
          const newStamp = stampById.get(item.id) ?? item.remediatedAt;
          return { ...item, remediatedAt: newStamp, remediatedByEmail: callerEmail };
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
