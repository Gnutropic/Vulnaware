// @polsia:user-owned — Pure single-POST helper for the /alerts page's
// bulk "Resolve selected" gesture. The page-side dialog
// (alerts-resolve-dialog.tsx) collects one OPTIONAL shared note
// (paragraph-capped at 500 chars) before the request fires — mirroring
// the bulk-reopen companion (alerts-bulk-reopen.ts) but with two
// deltas that derive from the new atomic bulk endpoint:
//
//   - ONE POST to /api/alerts/resolve (vs. parallel Promise.allSettled
//     over /api/alerts/[id]/resolve). The new endpoint resolves the
//     batch in a single prisma.$transaction — atomic at the DB level.
//     A 4xx/5xx on the batch leaves every row in its pre-batch state
//     instead of churning a partial subset.
//
//   - The body POSTed is `{ids: <ids>, ...(trimmedNote) ? {note:
//     trimmedNote} : {}}` — a single envelope that the route validates
//     once and stamps onto every row that flips. The trimmed note is
//     omitted from the body when blank so the route stamps
//     `closingNote: null` on every row (parity with the single-row
//     resolve composer on the detail card).
//
// Contract (what the page calls):
//   1. Pre-filter `items` to rows whose id is in the selection AND
//      whose status !== 'resolved' AND whose snooze window is NOT
//      still in the future. Already-resolved AND future-snoozed ids
//      are silently skipped — no fetch, no chip, no flip. Mirrors the
//      /resolve route's idempotent-already-resolved branch AND the
//      new snooze-arm filter so a stale click never churns
//      statusChangedAt on an already-closed row, and so a snoozed
//      alert remains re-triagable later (not stamped over by a bulk
//      resolve that wasn't aware of the snooze).
//   2. ONE POST to /api/alerts/resolve with the candidate id list.
//      Each result in the route's `results` array is mapped back to
//      the candidates by id — `status === 'resolved'` is the
//      authoritative "resolved" marker so the helper's outcome map
//      can derive `'ok'` / `'err'` per id. A non-2xx, a schema-drift
//      envelope, or a per-id status mismatch is treated as all-fail
//      so the page's toast can surface a coherent failure count.
//   3. On all-OK, mutate `items` so the targeted ids flip to status:
//      'resolved'; already-resolved and snoozed ids are untouched.
//   4. Return the per-row outcomes, the post-flip items, and the
//      ids that flipped — the page applies selection-clearing +
//      toast on all-OK from these.
//
// `fetchImpl` is the single dependency seam — tests pass a stub
// that returns canned responses per url; production wires the global
// `fetch`. Keeping it injectable (instead of relying on `globalThis`)
// makes the helper portable to a server-side unit suite that has no
// window.fetch binding.

import {
  AlertBulkResolveBody,
  AlertBulkResolveResponse,
  type AlertItem,
} from '@/lib/contracts/alerts';

export type BulkRowOutcome = 'ok' | 'err';

export interface BulkResolveInput {
  // Visible row set from /api/alerts envelope. Used both as the
  // pre-filter source AND as the optimistic-flip target on all-OK.
  items: AlertItem[];
  // The page's `selection` Set — the working set the operator built
  // up via the table/card checkboxes. Already persisted to
  // `?selected=`; this helper treats it as read-only.
  selection: Set<string>;
  // Optional shared note applied to every selected row. Mirrors the
  // reopen companion's `reason` shape (named-arg, OPTIONAL, trimmed
  // to barcode) but with the key renamed to `note` — the bulk route
  // stamps `Alert.closingNote` from this value. The
  // `AlertBulkResolveBody` schema accepts an OPTIONAL `note`
  // (NOT `.min(1)`) so the helper trims the blank branch to omit
  // the key entirely and the route stamps NULL on every row when
  // the helper collides with the page-side dialog's optional-note
  // posture. When `note.trim()` is zero length, the body sent is
  // `{ids: [...]}`. When non-empty, the body sent is `{ids:
  // [...], note: trimmed}`.
  note: string;
  // Fetch-like async function. Page wires `fetch`; tests wire a stub.
  // Returns the raw Response so the helper can branch on `.ok` and
  // parse `await res.json()` exactly the way the page island does.
  fetchImpl: typeof fetch;
}

export interface BulkResolveResult {
  // Ids that actually fanned out against /resolve. Excludes the
  // already-resolved AND snoozed ids the helper silently skipped.
  candidates: AlertItem[];
  // Per-row outcome map keyed by alert id. Missing from the map =
  // no fetch fired (already-resolved, snoozed, or selection-out-of-
  // range).
  outcomes: Map<string, BulkRowOutcome>;
  // The post-flip row set. Equals `input.items` on partial failure;
  // mirrors the optimistic flip on all-OK. The page's setter is
  // responsible for replacing `data.items`.
  items: AlertItem[];
  // True when every candidate id POST'd and returned status:
  // 'resolved'. Drives the page's success toast + selection clear.
  allOk: boolean;
  // Convenience for the page's success message — `1 alert resolved.`
  // vs `3 alerts resolved.`.
  okCount: number;
}

function isFutureSnooze(snoozedUntil: string | null, now: number): boolean {
  if (!snoozedUntil) return false;
  const t = Date.parse(snoozedUntil);
  return !Number.isNaN(t) && t > now;
}

export async function runBulkResolve(input: BulkResolveInput): Promise<BulkResolveResult> {
  const { items, selection, note, fetchImpl } = input;
  // (1) Pre-filter to selection ∩ non-resolved ∩ non-future-snooze
  // rows. Already-resolved and future-snoozed ids are silently
  // skipped — the page-side handler ALSO pre-filters, but doing it
  // here guarantees the helper is safe to call from any context
  // (e.g. a unit test that wires a stub `fetch` and expects the
  // helper to silently skip already-resolved / snoozed ids).
  // `now` is captured once so a transition across the boundary does
  // not slice the candidate set inconsistently.
  const now = Date.now();
  const candidates = items.filter(
    (item) =>
      selection.has(item.id) &&
      item.status !== 'resolved' &&
      !isFutureSnooze(item.snoozedUntil, now),
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

  const trimmedNote = note.trim();
  const requestBody: { ids: string[]; note?: string } = {
    ids: candidates.map((c) => c.id),
  };
  if (trimmedNote.length > 0) {
    requestBody.note = trimmedNote;
  }
  // Defensive parse against the route's wire shape so a future drift
  // between helper and route surfaces inside the helper at runtime
  // (the route's zod schema is the authoritative server-side gate).
  const safeBody = AlertBulkResolveBody.safeParse(requestBody);
  if (!safeBody.success) {
    // Pact-defensive — the requestBody is built from a `Set<string>` +
    // a trimmed string, so the schema failure here is itself an
    // invariant bug; treat every candidate as an 'err'.
    const outcomes = new Map<string, BulkRowOutcome>();
    for (const c of candidates) outcomes.set(c.id, 'err');
    return { candidates, outcomes, items, allOk: false, okCount: 0 };
  }

  try {
    const res = await fetchImpl('/api/alerts/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(safeBody.data),
      cache: 'no-store',
    });
    if (!res.ok) {
      // Non-2xx — every candidate is an 'err'. Items untouched.
      const outcomes = new Map<string, BulkRowOutcome>();
      for (const c of candidates) outcomes.set(c.id, 'err');
      return { candidates, outcomes, items, allOk: false, okCount: 0 };
    }
    const parsed = AlertBulkResolveResponse.safeParse(await res.json());
    if (!parsed.success) {
      // Schema-drift — every candidate is an 'err'. Items untouched.
      const outcomes = new Map<string, BulkRowOutcome>();
      for (const c of candidates) outcomes.set(c.id, 'err');
      return { candidates, outcomes, items, allOk: false, okCount: 0 };
    }
    // (3) Build per-id outcome map. Result ids missing from the
    // response (shouldn't happen but pact-defensively) are
    // painted 'err'. Per-id outcome is derived from the envelope's
    // authoritative `status` (NOT the candidate's pre-batch status)
    // so a row the route was unable to flip surfaces honestly.
    const outcomes = new Map<string, BulkRowOutcome>();
    let okCount = 0;
    const resolvedIds = new Set(parsed.data.results.map((r) => r.id));
    for (const c of candidates) {
      if (!resolvedIds.has(c.id)) {
        outcomes.set(c.id, 'err');
        continue;
      }
      const result = parsed.data.results.find((r) => r.id === c.id);
      if (result && result.status === 'resolved') {
        outcomes.set(c.id, 'ok');
        okCount += 1;
      } else {
        outcomes.set(c.id, 'err');
      }
    }
    const allOk = okCount === candidates.length;
    // (4) Optimistic flip — only on all-OK. Mutates a fresh array so
    // the page can replace its `data.items` state without aliasing the
    // previous envelope.
    const nextItems = allOk
      ? items.map((item) =>
          outcomes.get(item.id) === 'ok' ? { ...item, status: 'resolved' as const } : item,
        )
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
    // etc.) — every candidate is an 'err'. Items untouched.
    const outcomes = new Map<string, BulkRowOutcome>();
    for (const c of candidates) outcomes.set(c.id, 'err');
    return { candidates, outcomes, items, allOk: false, okCount: 0 };
  }
}
