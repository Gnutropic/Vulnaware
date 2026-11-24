// @polsia:user-owned — Pure single-POST helper for the /alerts page's
// bulk "Take ownership" gesture. Mirror of alerts-bulk-remediate.ts
// but with two keyed behavioral deltas driven by the new bulk
// endpoint:
//
//   - ONE POST to /api/alerts/ownership-batch (vs. parallel fan-out
//     over /api/alerts/[id]/claim). The new endpoint writes per-id
//     (NOT atomic across the batch) so an already-owned row does
//     NOT paper-over rows M ≠ N — instead, the response surfaces
//     the per-id skip into a `conflicts[]` envelope arm. Per-id
//     fan-out via Promise.allSettled (the single-id route posture)
//     is rejected because the brief explicitly mandates "per-id
//     UPDATE".
//
//   - "already-owned branch paints `'ok'`" — NOT `'err'`. The route
//     surfaces already-owned rows via the `conflicts[]` envelope
//     arm (HTTP 200, NOT 409). The bar's green badge is the right
//     signal; an operator-facing error toast on a "you already own
//     this" branch would be a UX anti-pattern. The helper pre-
//     filter drops already-owned candidates from the wire so a
//     typical bulk-take selection never produces conflicts; this
//     behavior matters when a stale post-mount reassignment race
//     surfaces a conflict at fetch time (the helper still paints
//     the conflict-arm ids `'ok'`).
//
// Contract (what the page calls):
//   1. Candidates = `items.filter(item => selection.has(item.id)
//      AND item.ownerId !== callerWorkspaceMemberId)`. Already-
//      owned rows are SILENTLY DROPPED from the candidate set
//      (they will surface in the route's `conflicts[]` arm if a
//      stale race re-introduces one — but the page pre-filter
//      short-circuits the wire round trip for obvious takes).
//   2. ONE POST to /api/alerts/ownership-batch with the candidate
//      id list (no `ownerId` — the assignment target is the
//      caller WorkspaceMember resolved server-side). Per-id
//      failure (HTTP non-2xx, schema drift, or an id missing from
//      both `results` AND `conflicts`) becomes `'err'` on the
//      outcome map for that id only.
//   3. Build per-id outcome map: id echoed in `results` → 'ok';
//      id echoed in `conflicts` → 'ok' (per the brief's "without
//      failure" stance); id in BOTH → impossible (the route
//      splits); id in NEITHER → 'err'. `allOk = okCount ===
//      candidates.length`.
//   4. Optimistic flip on all-OK stamps BOTH `ownerId`
//      (= callerWorkspaceMemberId, server-authoritative) AND
//      `ownerName` (= callerName ?? null) onto every targeted id.
//      Server-returned `ownerName` in `results[]` echoes
//      `callerName` (the route peer-reads User.name once
//      server-side), so the helper uses `callerName` for the
//      in-place flip without re-resolving names per id.
//   5. Return the per-row outcomes, the post-flip items, the
//      counts, AND the conflict count — the page composes the
//      "N alerts taken. M already owned." toast by reading
//      `conflictCount` separately.
//
// `fetchImpl` is the single dependency seam — tests pass a stub
// that returns canned responses per url; production wires the global
// `fetch`. Keeping it injectable (instead of relying on `globalThis`)
// makes the helper portable to a server-side unit suite that has no
// window.fetch binding.

import {
  AlertBulkOwnershipBody,
  AlertBulkOwnershipResponse,
  type AlertItem,
} from '@/lib/contracts/alerts';

export type BulkRowOutcome = 'ok' | 'err';

export interface BulkOwnershipInput {
  // Visible row set from /api/alerts envelope. Used both as the
  // pre-filter source AND as the optimistic-flip target on all-OK.
  items: AlertItem[];
  // The page's `selection` Set — the working set the operator built
  // up via the table/card checkboxes. Already persisted to
  // `?selected=`; this helper treats it as read-only.
  selection: Set<string>;
  // Caller's `WorkspaceMember.id` for the current team — used as
  // the already-owned-row pre-filter AND the optimistic-flip
  // stamp value. Resolved server-side at the top of the route via
  // `prisma.workspaceMember.findFirst({ where: { userId,
  // workspaceId, status: 'active' } })`; the page surfaces it via
  // an imperative ref so the callback closure reads the latest
  // value (the session may flip while a stale callback is sitting
  // in a pending state). Null when the caller has no active
  // roster row at submit-time — the page short-circuits silently.
  callerWorkspaceMemberId: string | null;
  // Caller's display name — used as the optimistic-flip
  // `ownerName` stamp. Resolved server-side at the top of the
  // route via `prisma.user.findUnique({ where: { id:
  // callerWorkspaceMember.userId }, select: { name: true } })`
  // and echoed server-side in the response envelope's `results[]`
  // arm. The helper uses this value for the in-place flip without
  // re-resolving per id.
  callerName: string | null;
  // Fetch-like async function. Page wires `fetch`; tests wire a stub.
  // Returns the raw Response so the helper can branch on `.ok` and
  // parse `await res.json()` exactly the way the page island does.
  fetchImpl: typeof fetch;
}

export interface BulkOwnershipResult {
  // Ids that actually fanned out against /ownership-batch. Excludes
  // already-owned rows by helper-side pre-filter so a typical
  // bulk-take selection never produces conflicts at the route.
  candidates: AlertItem[];
  // Per-row outcome map keyed by alert id. Missing from the map
  // means no fetch fired (empty selection).
  outcomes: Map<string, BulkRowOutcome>;
  // The post-flip row set. Equals `input.items` on partial failure;
  // mirrors the optimistic flip on all-OK.
  items: AlertItem[];
  // True when every candidate id POST'd and surfaced in either
  // `results` or `conflicts` (the brief's "without failure" stance
  // — conflict ids are still 'ok'). Drives the page's success toast
  // + selection clear.
  allOk: boolean;
  // Convenience for the page's success message —
  // `1 alert taken.` vs `3 alerts taken.`
  okCount: number;
  // Number of ids the route reported as already-owned via the
  // `conflicts[]` envelope arm. Distinguishable from `okCount`
  // because already-owned rows do not stamp a fresh owner (the
  // FK was already the caller). The page composes the success
  // toast from these two counts: "N taken. M already owned."
  conflictCount: number;
}

export async function runBulkTakeOwnership(
  input: BulkOwnershipInput,
): Promise<BulkOwnershipResult> {
  const { items, selection, callerWorkspaceMemberId, callerName, fetchImpl } = input;
  // (1) Pre-filter to selection AND not-already-owned. The bulk
  // route's per-id already-owned branch is reported via
  // `conflicts[]` (NOT an UPDATE) — saving the round trip on the
  // page side short-circuits the wire for obvious takes. An empty
  // pre-filter short-circuits before any fetch so the helper is
  // safe to call from any context. A null `callerWorkspaceMemberId`
  // short-circuits silently too — the route would 404 anyway on a
  // missing roster row, so firing a fetch the route can't fulfil
  // would just paint a misleading 5xx on the bar.
  if (callerWorkspaceMemberId === null) {
    return {
      candidates: [],
      outcomes: new Map(),
      items,
      allOk: true,
      okCount: 0,
      conflictCount: 0,
    };
  }
  const candidates = items.filter(
    (item) => selection.has(item.id) && item.ownerId !== callerWorkspaceMemberId,
  );
  if (candidates.length === 0) {
    return {
      candidates: [],
      outcomes: new Map(),
      items,
      allOk: true,
      okCount: 0,
      conflictCount: 0,
    };
  }

  // Defensive parse against the route's wire shape so a future drift
  // between helper and route surfaces inside the helper at runtime
  // (the route's zod schema is the authoritative server-side gate).
  const requestBody = { ids: candidates.map((c) => c.id) };
  const safeBody = AlertBulkOwnershipBody.safeParse(requestBody);
  if (!safeBody.success) {
    // Pact-defensive — the requestBody is built from a `Set<string>`
    // so the schema failure here is itself an invariant bug; treat
    // every candidate as 'err'.
    const outcomes = new Map<string, BulkRowOutcome>();
    for (const c of candidates) outcomes.set(c.id, 'err');
    return {
      candidates,
      outcomes,
      items,
      allOk: false,
      okCount: 0,
      conflictCount: 0,
    };
  }

  try {
    const res = await fetchImpl('/api/alerts/ownership-batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(safeBody.data),
      cache: 'no-store',
    });
    if (!res.ok) {
      // Non-2xx — every candidate is 'err'. Items untouched.
      const outcomes = new Map<string, BulkRowOutcome>();
      for (const c of candidates) outcomes.set(c.id, 'err');
      return {
        candidates,
        outcomes,
        items,
        allOk: false,
        okCount: 0,
        conflictCount: 0,
      };
    }
    const parsed = AlertBulkOwnershipResponse.safeParse(await res.json());
    if (!parsed.success) {
      // Schema-drift — every candidate is 'err'. Items untouched.
      const outcomes = new Map<string, BulkRowOutcome>();
      for (const c of candidates) outcomes.set(c.id, 'err');
      return {
        candidates,
        outcomes,
        items,
        allOk: false,
        okCount: 0,
        conflictCount: 0,
      };
    }
    // Build per-id outcome map. The brief's "without failure"
    // stance: id echoed in `results` OR `conflicts` → 'ok'; the
    // route NEVER echoes the same id in both arms (a per-id write
    // is either transfer or already-owned); id in NEITHER →
    // 'err' (silent cross-team / schema-drift fall-through).
    // `conflictCount` tracks the second arm separately so the
    // page's success toast can distinguish "taken" from
    // "already owned".
    const resultIds = new Set(parsed.data.results.map((r) => r.id));
    const conflictIds = new Set(parsed.data.conflicts.map((c) => c.id));
    const outcomes = new Map<string, BulkRowOutcome>();
    let okCount = 0;
    let conflictCount = 0;
    for (const c of candidates) {
      if (resultIds.has(c.id)) {
        outcomes.set(c.id, 'ok');
        okCount += 1;
        continue;
      }
      if (conflictIds.has(c.id)) {
        outcomes.set(c.id, 'ok');
        okCount += 1;
        conflictCount += 1;
        continue;
      }
      outcomes.set(c.id, 'err');
    }
    const allOk = okCount === candidates.length;

    // (4) Optimistic flip — only on all-OK. Mutates a fresh array
    // so the page can replace its `data.items` state without aliasing
    // the previous envelope. Stamps BOTH `ownerId` (= caller
    // WorkspaceMember.id, server-authoritative) AND `ownerName`
    // (= callerName ?? null). Server-returned `ownerName` in
    // `results[]` echoes `callerName` (the route peer-reads
    // User.name once server-side), so the helper uses
    // `callerName` for the in-place flip without re-resolving per
    // id.
    const nextItems = allOk
      ? items.map((item) => {
          if (outcomes.get(item.id) !== 'ok') return item;
          return {
            ...item,
            ownerId: callerWorkspaceMemberId,
            ownerName: callerName,
          };
        })
      : items;
    return {
      candidates,
      outcomes,
      items: nextItems,
      allOk,
      okCount,
      conflictCount,
    };
  } catch {
    // Fetch-throw (network reset, JSON parse error on non-JSON 5xx,
    // etc.) — every candidate is 'err'. Items untouched.
    const outcomes = new Map<string, BulkRowOutcome>();
    for (const c of candidates) outcomes.set(c.id, 'err');
    return {
      candidates,
      outcomes,
      items,
      allOk: false,
      okCount: 0,
      conflictCount: 0,
    };
  }
}
