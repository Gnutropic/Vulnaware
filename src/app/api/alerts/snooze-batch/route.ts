// @polsia:user-owned — POST /api/alerts/snooze-batch. Atomic bulk-snooze
// endpoint that stamps a future `snoozedUntil` window on a batch of
// alert ids in a single transaction. Sister to POST /api/alerts/[id]
// /snooze (the per-row composer on the detail page still uses the
// single-id route) and to POST /api/alerts/resolve (the bulk-resolve
// companion sharing the same atomic-bulk posture), but with the
// following deltas that drive the bulk-snooze gesture:
//
//   1. ONE transaction (one prisma.$transaction) so the write is
//      all-or-nothing — a 4xx/5xx on row N leaves rows M ≠ N in their
//      pre-batch state. Per-id fan-out via Promise.allSettled (the
//      posture the single-id /snooze route gets) is NOT atomic at the
//      DB level; the bulk endpoint closes that gap.
//
//   2. Scope check FIRST — a single prisma.alert.findMany with
//      `where: { id: { in: uniqueIds }, teamId }`. Cross-team ids are
//      SILENTLY DROPPED from both the transaction and the response
//      envelope. HTTP stays 200 with a partial `results` array —
//      a deliberate divergence from POST /api/alerts/resolve (which
//      404s on cross-team). The divergence is pinned explicitly by
//      the unit + integration tests so a copy-paste drift back to 404
//      fails the suite.
//
//   3. Idempotent refresh — the route overwrites `snoozedUntil` on
//      every row in the batch without a prior-value gate. A
//      row that's currently snoozed (or even snoozed by the same
//      caller an hour ago) gets the new window stamped atop its
//      current value. Re-applying "Snooze 7d" refreshes the window.
//
// Body contract:
//   - `ids` is a non-empty array of alert ids (min(1) so an empty
//     selection 400s through; the page-side handler pre-filters but
//     the schema enforces it server-side too).
//   - Two arms (mirror of `AlertSnoozeBody`):
//     - `duration` is the '1d' | '3d' | '7d' | '30d' literal — server
//       stamps `now + WINDOW_MS[duration]` so client clock-skew never
//       reaches the row. The 3d arm is wired through the /alerts
//       floating bulk-bar's popover (1d / 3d / 7d / 30d picker) — the
//       schema widening cascades to this route via the shared
//       `SnoozeDuration` enum in `@/lib/contracts/alerts`.
//     - `until` is an ISO-8601 timestamp the client supplies
//       verbatim. Flows through the bar's custom-date popover entry so
//       operators can stamp a non-default window (e.g. "Snooze until
//       next Friday"). The route echoes the supplied ISO directly so
//       the on-row countdown reads the future moment the operator
//       picked. `null` is the explicit "un-snooze" signal (a row's
//       `snoozedUntil` column is set back to NULL). An invalid ISO
//       400s through the **shared** refine BEFORE the scope gate so a
//       UI typo is caught at the schema layer.
//   - `.strict()` per arm so an undisclosed caller field 400s through.
//
// Fail-closed:
//   - Any throw inside the route → 500 JSON.

import 'server-only';
import { NextResponse } from 'next/server';
import {
  AlertBulkSnoozeBody,
  AlertBulkSnoozeResponse,
  AlertBulkSnoozeRow,
} from '@/lib/contracts/alerts';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { requireTeamRole } from '@/lib/team-auth';

const DAY_MS = 24 * 60 * 60 * 1000;
// WINDOW_MS aligns the brief's duration enum with the SnoozeCard's
// `WINDOW_OPTIONS` ms table so server-stamped and client-stamped
// SnoozeCard surfaces produce the same on-row countdown when the same
// caller snoozes from both surfaces. Identical copy to
// `src/app/api/alerts/[id]/snooze/route.ts` so a future widening of
// either the bulk route or the single-id route cascades through a
// single source of truth if the team decides to extract this table
// into a shared helper. The 3d arm is interleaved between 1d and 7d
// so ascending key order matches the picker layout on the /alerts
// bulk-bar popover.
const WINDOW_MS: Record<'1d' | '3d' | '7d' | '30d', number> = {
  '1d': DAY_MS,
  '3d': 3 * DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
};

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return withApiRequest(req, async () => {
    let ctx: Awaited<ReturnType<typeof requireTeamRole>>;
    try {
      ctx = await requireTeamRole('member');
    } catch (res) {
      return res as Response;
    }

    setRequestAuth({ userId: ctx.user.id, teamId: ctx.membership.teamId });
    const teamId = ctx.membership.teamId;

    try {
      // Body parse FIRST — malformed JSON 400s BEFORE the scope gate
      // so the schema validation sits ahead of any DB read. Mirror of
      // POST /api/alerts/resolve.
      let bodyInput: unknown = {};
      try {
        bodyInput = await req.json();
      } catch {
        return NextResponse.json(
          { error: 'bad_request', message: 'invalid JSON' },
          { status: 400 },
        );
      }
      const parsedBody = AlertBulkSnoozeBody.safeParse(bodyInput);
      if (!parsedBody.success) {
        return NextResponse.json(
          { error: 'bad_request', issues: parsedBody.error.flatten() },
          { status: 400 },
        );
      }
      const { ids } = parsedBody.data;

      // Dedup the request id set so a caller posting duplicate ids
      // (manual selection + a stale `?selected=` URL preload, for
      // example) does not double-charge the scope gate.
      const uniqueIds = Array.from(new Set(ids));

      // Scope check FIRST — and SILENT cross-team drop. A cross-team
      // id (or a fully missing id) is filtered out of the transaction
      // + the response envelope; HTTP stays 200 with a partial
      // `results` array. This is a deliberate divergence from the
      // /resolve route's opaque-404 posture — pin the test for it
      // explicitly (see `silent cross-team drop` in the unit suite).
      const existing = await prisma.alert.findMany({
        where: { id: { in: uniqueIds }, teamId },
        select: { id: true, teamId: true },
      });
      // liveIds is the scope-checked, team-bounded id set. Every
      // subsequent step — transaction + envelope — uses `liveIds`,
      // NOT `uniqueIds`, so a cross-team id can never reach a
      // transaction row.
      const liveIds = existing.map((row) => row.id);

      // Compute the per-row snoozedUntil stamp AT THE END. The
      // `duration` arm stamps `now + WINDOW_MS[duration]` so client
      // clock-skew never reaches the row; the `until` arm echoes the
      // client-supplied ISO verbatim so the operator's future pick
      // lands the row's countdown on the moment THEY chose (not the
      // server's). `null` on either arm clears the save (writes
      // NULL). Mirror of POST /api/alerts/[id]/snooze's
      // `'duration' in data ? … : …` branch.
      const until: string | null =
        'duration' in parsedBody.data
          ? new Date(Date.now() + WINDOW_MS[parsedBody.data.duration]).toISOString()
          : (parsedBody.data.until ?? null);

      const stamp = until ? new Date(until) : null;

      // Atomic write — a single prisma.$transaction that fans out
      // across every team-scoped id. Each per-id update selects the
      // {id, teamId, snoozedUntil} trio so the response envelope can
      // be assembled without a round trip back to the DB. Idempotent
      // refresh: the route unconditionally writes `snoozedUntil =
      // stamp` on every row — no prior-value gate, no churn check.
      // Re-applying "Snooze 7d" simply overwrites the prior window.
      // `until:null` clears the save (writes NULL on every row), the
      // same semantics the single-id "[id]/snooze" route has for its
      // own `until:null` arm.
      const updated =
        liveIds.length === 0
          ? []
          : await prisma.$transaction(
              liveIds.map((id) =>
                prisma.alert.update({
                  where: { id },
                  data: { snoozedUntil: stamp },
                  select: { id: true, teamId: true, snoozedUntil: true },
                }),
              ),
            );

      // Defence-in-depth — pact-defensive only. Should be impossible
      // after the scope-check filter: a tampered race produced a
      // cross-team row in the transaction result. Bail to opaque 404
      // so the caller cannot distinguish that branch from a real
      // not_found (the resolve route's posture).
      for (const row of updated) {
        if (row.teamId !== teamId) {
          return NextResponse.json({ error: 'not_found' }, { status: 404 });
        }
      }

      // Per-result envelope via AlertBulkSnoozeRow.parse — slim
      // `{id, snoozedUntil}` per row, mirrors the on-screen column
      // shape so the helper's optimistic flip and a future refetch
      // share the same wire contract.
      const results = updated.map((row) =>
        AlertBulkSnoozeRow.parse({
          id: row.id,
          snoozedUntil: row.snoozedUntil ? row.snoozedUntil.toISOString() : null,
        }),
      );

      const parsed = AlertBulkSnoozeResponse.parse({ results });
      return NextResponse.json(parsed);
    } catch {
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  });
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'POST' } },
  );
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
