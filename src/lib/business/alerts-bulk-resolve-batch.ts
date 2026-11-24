// @polsia:user-owned — Pure single-POST helper for the /alerts page's
// bulk "Resolve selected" popover gesture. Mirror of
// `alerts-bulk-resolve.ts` (the dialogue-driven bulk-resolve that
// fans out to /api/alerts/resolve) and `alerts-bulk-snooze.ts`
// (the bulk-snooze companion). Three deltas drive this helper:
//
//   - ONE POST to /api/alerts/resolve-batch (vs. parallel fan-out or
//     the dialogue-driven single-POST path). The new endpoint
//     resolves the batch in a single prisma.$transaction that fans
//     out an Alert.update per id AND, when a non-blank note is
//     supplied, an AlertNote.create per id — atomic at the DB level.
//     A 4xx/5xx on the batch leaves every row in its pre-batch
//     state.
//
//   - Status pre-filter drops already-`resolved` AND future-
//     snoozed rows from the candidate set. Mirrors
//     `runBulkResolve`'s posture: a re-stamp on an already-closed
//     row is never meaningful, and a snoozed row remains
//     re-triagable later so the bulk gesture never stamps over an
//     active snooze.
//
//   - Optimistic flip stamps `status: 'resolved'` on every targeted
//     id on all-OK. The slim `AlertBulkResolveBatchRow` envelope
//     does NOT round-trip `closingNote` (the slim shape omits it),
//     so the optimistic flip mirrors a blank `closingNote` on row
//     state — a follow-up /api/alerts refetch is responsible for
//     reading back the typed `closingNote` from the parent
//     AlertItem envelope.
//
// Contract (what the page calls):
//   1. Candidates = `items.filter(item => selection.has(item.id) &&
//      item.status !== 'resolved' && NOT future-snoozed)`. Already-
//      resolved AND future-snoozed ids are silently skipped — no
//      fetch, no chip, no flip. Mirrors `/resolve-batch`'s scope +
//      snooze-gate postures.
//   2. ONE POST to /api/alerts/resolve-batch with the candidate id
//      list + an OPTIONAL trimmed note (0–2000 chars, matches
//      AlertNote body cap). The note is omitted from the body when
//      blank so the route's transaction stays in the bare
//      `alert.update` arm — no AlertNote.create, no breadcrumb
//      stamp on every row.
//   3. Build per-id outcome map: id echoed in `results` → 'ok';
//      else → 'err'. `allOk = okCount === candidates.length`.
//   4. Optimistic flip on all-OK stamps `status: 'resolved'` on
//      every targeted id so the row chip flips to Resolved (the
//      /alerts page's `item.status === 'resolved'` Badge render).
//   5. Return the per-row outcomes, the post-flip items, the
//      counts — the page composes the success toast + selection-
//      clear from these.
//
// `fetchImpl` is the single dependency seam — tests pass a stub
// that returns canned responses per url; production wires the global
// `fetch`. Keeping it injectable (instead of relying on
// `globalThis`) makes the helper portable to a server-side unit
// suite that has no window.fetch binding.

import {
  AlertBulkResolveBatchBody,
  AlertBulkResolveBatchResponse,
  type AlertItem,
} from '@/lib/contracts/alerts';

export type BulkRowOutcome = 'ok' | 'err';

export interface BulkResolveBatchInput {
  // Visible row set from /api/alerts envelope. Used both as the
  // pre-filter source AND the optimistic-flip target on all-OK.
  items: AlertItem[];
  // The page's `selection` Set — the working set the operator
  // built up via the table/card checkboxes. Already persisted to
  // `?selected=`; this helper treats it as read-only.
  selection: Set<string>;
  // Optional shared note applied to every selected row. Mirrors
  // the single-id resolve composer / bulk-resolve companion's
  // `note` shape (named-arg, OPTIONAL, trimmed) — the /resolve-
  // batch route stamps (a) an `Alert.update({...closingNote...})`
  // on the row itself when the note is non-blank AND (b) one
  // `AlertNote.create` per resolved alert when the note is
  // non-blank. The `AlertBulkResolveBatchBody` schema accepts an
  // OPTIONAL `note` (NOT `.min(1)`) so the helper trims the blank
  // branch to omit the key entirely; the route's transaction
  // then runs in the bare alert.update arm.
  note: string;
  // Fetch-like async function. Page wires `fetch`; tests wire a
  // stub. Returns the raw Response so the helper can branch on
  // `.ok` and parse `await res.json()` exactly the way the page
  // island does.
  fetchImpl: typeof fetch;
}

export interface BulkResolveBatchResult {
  // Ids that actually fanned out against /resolve-batch. Excludes
  // already-resolved AND future-snoozed ids the helper silently
  // skipped.
  candidates: AlertItem[];
  // Per-row outcome map keyed by alert id. Missing from the map =
  // no fetch fired (already-resolved, future-snoozed, or
  // selection-out-of-range).
  outcomes: Map<string, BulkRowOutcome>;
  // The post-flip row set. Equals `input.items` on partial
  // failure; mirrors the optimistic flip on all-OK. The page's
  // setter is responsible for replacing `data.items`.
  items: AlertItem[];
  // True when every candidate id POST'd and returned status:
  // 'resolved'. Drives the page's success toast + selection
  // clear.
  allOk: boolean;
  // Convenience for the page's success message — `1 alert
  // resolved.` vs `3 alerts resolved.`.
  okCount: number;
}

function isFutureSnooze(snoozedUntil: string | null, now: number): boolean {
  if (!snoozedUntil) return false;
  const t = Date.parse(snoozedUntil);
  return !Number.isNaN(t) && t > now;
}

export async function runBulkResolveBatch(
  input: BulkResolveBatchInput,
): Promise<BulkResolveBatchResult> {
  const { items, selection, note, fetchImpl } = input;
  // (1) Pre-filter to selection ∩ non-resolved ∩ non-future-snooze
  // rows. Already-resolved AND future-snoozed ids are silently
  // skipped — mirrors runBulkResolve + the /resolve-batch route's
  // scope + snooze-gate branches. A `now` captured once so a
  // transition across the boundary does not slice the candidate
  // set inconsistently.
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
  const safeBody = AlertBulkResolveBatchBody.safeParse(requestBody);
  if (!safeBody.success) {
    // Pact-defensive — the requestBody is built from a `Set<string>`
    // + a trimmed string so the schema failure here is itself an
    // invariant bug; treat every candidate as an 'err'.
    const outcomes = new Map<string, BulkRowOutcome>();
    for (const c of candidates) outcomes.set(c.id, 'err');
    return { candidates, outcomes, items, allOk: false, okCount: 0 };
  }

  try {
    const res = await fetchImpl('/api/alerts/resolve-batch', {
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
    const parsed = AlertBulkResolveBatchResponse.safeParse(await res.json());
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
    const stampedById = new Map(parsed.data.results.map((r) => [r.id, r]));
    const outcomes = new Map<string, BulkRowOutcome>();
    let okCount = 0;
    for (const c of candidates) {
      const stamped = stampedById.get(c.id);
      if (stamped && stamped.status === 'resolved') {
        outcomes.set(c.id, 'ok');
        okCount += 1;
      } else {
        outcomes.set(c.id, 'err');
      }
    }
    const allOk = okCount === candidates.length;
    // (4) Optimistic flip — only on all-OK. Mutates a fresh array
    // so the page can replace its `data.items` state without
    // aliasing the previous envelope. Stamps ONLY `status:
    // 'resolved'` on every targeted id (the slim envelope does
    // NOT carry `closingNote`, so the flip mirrors a NULL
    // closingNote on row state — a follow-up /api/alerts refetch
    // reads back the typed closingNote from the parent
    // AlertItem envelope).
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
    // Fetch-throw (network reset, JSON parse error on non-JSON
    // 5xx, etc.) — every candidate is an 'err'. Items untouched.
    const outcomes = new Map<string, BulkRowOutcome>();
    for (const c of candidates) outcomes.set(c.id, 'err');
    return { candidates, outcomes, items, allOk: false, okCount: 0 };
  }
}
