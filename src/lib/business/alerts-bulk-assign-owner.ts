// @polsia:user-owned — Pure single-POST helper for the /alerts page's
// bulk "Assign owner…" gesture. Mirror of alerts-bulk-ownership.ts
// (the per-id "Take ownership" path that resolves the target from
// session) with these deltas driven by the bulk endpoint:
//
//   - ONE POST to /api/alerts/assign-owner-batch (vs. parallel
//     fan-out over /api/alerts/[id]/owner). The new endpoint
//     stamps the chosen FK in a single prisma.$transaction —
//     atomic at the DB level. A 4xx/5xx on the batch leaves every
//     row in its pre-batch state. The forward posture: the body
//     supplies the picked FK explicitly; the route validates the
//     FK against the caller's workspace and 400s on a cross-team
//     mis-click (mirrors PATCH /[id]/owner's posture verbatim).
//
//   - No owner-equality pre-filter — selecting a row that already
//     carries the picked FK is the explicit idempotent branch.
//     The bulk route re-stamps the same FK (no churn since the
//     column lands on its prior value, but the row still echoes
//     in `results[]`); the helper does NOT drop these candidates
//     pre-network. Mirrors /snooze-batch's idempotent refresh
//     posture so a re-applied assignment is a no-op success, not
//     a UI surprise.
//
//   - Optimistic flip stamps BOTH `ownerId` (= the picked FK)
//     AND `ownerName` (= the resolved display name the page
//     surfaces from the roster) on every targeted id. The route
//     peer-resolves `ownerName` server-side and echoes it in
//     `results[]`, but the helper uses the page-side
//     `{ownerId, ownerName}` pair the caller passes so the flip
//     never has to re-resolve names per id AND the optimistic
//     flip matches the on-screen roster 1:1.
//
// Contract (what the page calls):
//   1. Candidates = `items.filter(item => selection.has(item.id))`.
//      Already-owned AND non-owned rows are all valid candidates —
//      re-applying the same owner is the explicit behavior (the
//      idempotent-refresh branch on the bulk route).
//   2. ONE POST to /api/alerts/assign-owner-batch with `{ids,
//      ownerId}`. The picked FK is the resolved
//      `WorkspaceMember.id` from the page's roster fetch (NOT
//      the caller's identity — the picker is operator-driven).
//      `null` `ownerId` short-circuits BEFORE any fetch (the
//      page's posture: the bulk path is forward-only today;
//      the `ownerId: null` route arm is reserved for a future
//      "Bulk unassign" gesture and the helper pins that
//      intentional omission).
//   3. Per-row outcome: id echoed in `results` → 'ok'; else →
//      'err'. `allOk = okCount === candidates.length`.
//   4. Optimistic flip on all-OK stamps BOTH `ownerId` AND
//      `ownerName` on every targeted id (the page-resolved pair,
//      not a re-derived client moment).
//   5. Return the per-row outcomes, the post-flip items, the
//      counts — the page composes the success toast from
//      `okCount`.

import {
  AlertBulkAssignOwnerBody,
  AlertBulkAssignOwnerResponse,
  type AlertItem,
} from '@/lib/contracts/alerts';

export type BulkRowOutcome = 'ok' | 'err';

export interface BulkAssignOwnerInput {
  // Visible row set from /api/alerts envelope. Used both as the
  // pre-filter source AND the optimistic-flip target on all-OK.
  items: AlertItem[];
  // The page's `selection` Set — the working set the operator
  // built up via the table/card checkboxes. Already persisted
  // to `?selected=`; this helper treats it as read-only.
  selection: Set<string>;
  // The picked member FK (= `WorkspaceMember.id` resolved from
  // /api/team/members). The route validates the FK against the
  // caller's workspace; a cross-team id 400s with a typed field
  // error so the page can re-paint the picker's failure toast.
  // A null `ownerId` short-circuits before any fetch (the route
  // accepts `ownerId: null` to clear the FK, but the bulk
  // gesture today is forward-only — the picker never emits null).
  ownerId: string | null;
  // The picked member's display name — used as the optimistic-
  // flip `ownerName` stamp. The route peer-resolves
  // `ownerName` server-side and echoes it in `results[]`; the
  // helper uses this page-resolved value for the in-place flip
  // so the on-screen roster matches the stamped value WITHOUT a
  // per-id re-resolution, AND so the optimistic flip matches a
  // stale `User.name` race the server may have lost (the
  // server's value is authoritative via the next refetch).
  ownerName: string | null;
  // Fetch-like async function. Page wires `fetch`; tests wire a
  // stub. Returns the raw Response so the helper can branch on
  // `.ok` and parse `await res.json()` exactly the way the page
  // island does.
  fetchImpl: typeof fetch;
}

export interface BulkAssignOwnerResult {
  // Ids that actually fanned out against
  // /assign-owner-batch. Includes already-owned rows by design
  // (the bulk route re-stamps the same FK on every candidate).
  candidates: AlertItem[];
  // Per-row outcome map keyed by alert id. Missing from the map
  // means no fetch fired (empty selection OR a `null` `ownerId`
  // short-circuit).
  outcomes: Map<string, BulkRowOutcome>;
  // The post-flip row set. Equals `input.items` on partial
  // failure; mirrors the optimistic flip on all-OK.
  items: AlertItem[];
  // True when every candidate id POST'd and returned an
  // envelope entry. Drives the page's success toast + selection
  // clear.
  allOk: boolean;
  // Convenience for the page's success message —
  // `1 alert assigned to <name>.` vs `3 alerts assigned to <name>.`
  okCount: number;
}

export async function runBulkAssignOwner(
  input: BulkAssignOwnerInput,
): Promise<BulkAssignOwnerResult> {
  const { items, selection, ownerId, ownerName, fetchImpl } = input;
  // Forward-only short-circuit: a `null` `ownerId` skips the
  // fetch entirely. The route accepts `null` (it clears the FK),
  // but the bulk gesture today is operator-driven — picking a
  // specific member. A future "Bulk unassign" arm would
  // re-introduce the `null` branch here as a separate
  // `runBulkUnassign` helper.
  if (ownerId === null) {
    return {
      candidates: [],
      outcomes: new Map(),
      items,
      allOk: true,
      okCount: 0,
    };
  }
  // (1) Pre-filter to selection. NO already-owned / status drop —
  // the bulk route re-stamps the same FK on every candidate, so
  // re-applying an assignment is an idempotent success. An empty
  // selection short-circuits before any fetch so the helper is
  // safe to call from any context.
  const candidates = items.filter((item) => selection.has(item.id));
  if (candidates.length === 0) {
    return {
      candidates: [],
      outcomes: new Map(),
      items,
      allOk: true,
      okCount: 0,
    };
  }

  // Defensive parse against the route's wire shape so a future
  // drift between helper and route surfaces inside the helper
  // at runtime (the route's zod schema is the authoritative
  // server-side gate).
  const requestBody = { ids: candidates.map((c) => c.id), ownerId };
  const safeBody = AlertBulkAssignOwnerBody.safeParse(requestBody);
  if (!safeBody.success) {
    // Pact-defensive — the requestBody is built from a `Set<string>`
    // + a `string` `ownerId` so a schema failure here is itself an
    // invariant bug; treat every candidate as 'err'.
    const outcomes = new Map<string, BulkRowOutcome>();
    for (const c of candidates) outcomes.set(c.id, 'err');
    return { candidates, outcomes, items, allOk: false, okCount: 0 };
  }

  try {
    const res = await fetchImpl('/api/alerts/assign-owner-batch', {
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
    const parsed = AlertBulkAssignOwnerResponse.safeParse(await res.json());
    if (!parsed.success) {
      // Schema-drift — every candidate is 'err'. Items untouched.
      const outcomes = new Map<string, BulkRowOutcome>();
      for (const c of candidates) outcomes.set(c.id, 'err');
      return { candidates, outcomes, items, allOk: false, okCount: 0 };
    }
    // Build per-id outcome map. id echoed in `results` → 'ok';
    // missing → 'err'. The route silently drops cross-team +
    // snoozed-arm rows from `results[]` — a missing row surfaces
    // here as 'err' so the bar paints a meaningful indicator chip
    // (the page's selection would never carry a cross-team id in
    // practice, but a stale post-mount id swap can surface).
    const stampById = new Map(parsed.data.results.map((r) => [r.id, r]));
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
    // (4) Optimistic flip — only on all-OK. Mutates a fresh
    // array so the page can replace its `data.items` state
    // without aliasing the previous envelope. Stamps BOTH
    // `ownerId` (= the picked FK, server-authoritative from the
    // route's response) AND `ownerName` (= the page-resolved
    // display name). The route echoes the same pair in
    // `results[]` (server-resolved from the FK), but the helper
    // uses the page-resolved pair so the flip matches a stale
    // `User.name` race where the server lost to a recent
    // `User.update`.
    const nextItems = allOk
      ? items.map((item) => {
          if (outcomes.get(item.id) !== 'ok') return item;
          return {
            ...item,
            ownerId,
            ownerName,
          };
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
    // Fetch-throw (network reset, JSON parse error on a non-JSON
    // 5xx, etc.) — every candidate is 'err'. Items untouched.
    const outcomes = new Map<string, BulkRowOutcome>();
    for (const c of candidates) outcomes.set(c.id, 'err');
    return { candidates, outcomes, items, allOk: false, okCount: 0 };
  }
}
