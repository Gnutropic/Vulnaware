// @polsia:user-owned — POST /api/alerts/resolve-batch. Bulk-resolve
// gesture for the /alerts popover CTA. Companion to POST /api/alerts/
// resolve (the dialogue-driven bulk-resolve that fans out via the
// detail card's [id]/resolve route) and to POST /api/alerts/
// snooze-batch / assign-owner-batch (the atomic single-transaction
// companions). Behavioral deltas that drive this gesture:
//
//   1. ONE transaction (one prisma.$transaction with a per-id fan-out)
//      so the write is all-or-nothing — a 4xx/5xx on row N leaves
//      rows M ≠ N in their pre-batch state. Per-id fan-out via
//      Promise.allSettled (the posture /resolve gets) is NOT atomic
//      at the DB level; the bulk endpoint closes that gap.
//
//   2. Scope check FIRST — single prisma.alert.findMany with
//      `where: { id: { in: uniqueIds }, teamId }`. Cross-team ids
//      AND missing ids are SILENTLY DROPPED from the transaction and
//      the response envelope; HTTP stays 200 with a partial
//      `results` array. Deliberate divergence from POST
//      /api/alerts/resolve (which 404s on cross-team) — mirrors
//      /snooze-batch's posture and the brief's "atomic write through
//      Prisma" companion pattern.
//
//   3. Snooze-arm gate — rows whose `snoozedUntil > now` are
//      silently skipped from both the transaction AND the response
//      envelope. Mirrors /resolve route: a snoozed row stays
//      re-triagable later, the bulk gesture never stamps over an
//      active snooze.
//
//   4. Atomic write — one prisma.$transaction that fans out a fixed
//      per-row fan-out across every live id:
//        (a) `prisma.alert.update(...)` — stamps status +
//            statusChangedAt + closedAt + closedBy + closingNote on
//            the same row. A blank note writes NULL closingNote; a
//            non-blank note writes the trimmed text.
//        (b) When a non-blank note is supplied, `prisma.alertNote
//            .create(...)` — INSERTs one AlertNote row keyed by
//            alertId with the trimmed body so the bottom-of-page
//            notes pane sees the resolution breadcrumb. Mirrors the
//            /api/alerts/[id]/notes POST shape minus the email
//            dispatch (no transactional fire-and-forget on the bulk
//            path; the bulk gesture is a single round trip, and
//            emitting N emails would crowd a small operator inbox).
//      The two ops run inside the same `prisma.$transaction(async
//      (tx) => ...)` callback so a per-row failure rolls the whole
//      batch back. Every live row carries the same shared `now`
//      stamp on closedAt + statusChangedAt + AlertNote.createdAt so
//      an audit reader can group flips from the same bulk action at
//      a glance.
//
//   5. Per-row envelope via `AlertBulkResolveBatchRow.parse` — slim
//      `{id, status, statusChangedAt, closedAt, closedBy}` derived
//      from the update's returned `select`. Mirrors the
//      `AlertResolveResponse` close-stamp trio so the helper's
//      optimistic flip + a future refetch share the same column
//      family end-to-end. `closingNote` is intentionally OMITTED
//      from the slim wire (the bulk path stamps it onto the Alert
//      row but the bulk response does not need to round-trip it
//      back — a follow-up /api/alerts refetch reads the column off
//      the parent AlertItem envelope).
//
//   6. Empty `liveIds` returns `{results: []}` after the scope +
//      snooze-gate filters collapse to zero rows (e.g. caller
//      selected every future-snoozed row in the page's working
//      set). The transaction is short-circuited so a 200 with no
//      rows is a deliberate "nothing to do, no fan-out" success.
//
// Body contract:
//   - `ids` is a non-empty array of alert ids (`min(1)` so an empty
//     selection 400s through — no empty-selection write path).
//   - `note` is OPTIONAL, 0–2000 chars after trim, aligned with
//     `AlertNoteCreateBody.body`'s max. The route emits an
//     AlertNote.create per row alongside the Alert.update only
//     when a non-blank note is supplied; a blank note triggers the
//     bare alert.update arm so the bulk "click without typing"
//     gesture leaves no empty breadcrumb on every row's notes pane.
//   - `.strict()` per the schema, so an undisclosed caller field
//     400s through.
//
// Fail-closed:
//   - Any throw inside the route → 500 JSON.

import 'server-only';
import { NextResponse } from 'next/server';
import {
  AlertBulkResolveBatchBody,
  AlertBulkResolveBatchResponse,
  AlertBulkResolveBatchRow,
} from '@/lib/contracts/alerts';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { requireTeamRole } from '@/lib/team-auth';

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
      // /snooze-batch and /assign-owner-batch.
      let bodyInput: unknown = {};
      try {
        bodyInput = await req.json();
      } catch {
        return NextResponse.json(
          { error: 'bad_request', message: 'invalid JSON' },
          { status: 400 },
        );
      }
      const parsedBody = AlertBulkResolveBatchBody.safeParse(bodyInput);
      if (!parsedBody.success) {
        return NextResponse.json(
          { error: 'bad_request', issues: parsedBody.error.flatten() },
          { status: 400 },
        );
      }
      const { ids } = parsedBody.data;
      const trimmedNote = parsedBody.data.note?.trim() ?? '';
      // AlertNote.create fans out only when a non-blank note is
      // supplied. A blank note triggers the bare alert.update arm so
      // the operator's "click without typing" gesture leaves no
      // empty breadcrumb on the row's notes pane — semantics the
      // single-id /[id]/resolve route already has via
      // `closingNote: closingNoteValue` (closed with NULL note).
      const shouldInsertNote = trimmedNote.length > 0;

      // Dedup the request id set so a caller posting duplicate ids
      // (a stale `?selected=` URL preload, for example) does not
      // double-charge the scope gate or double-fan the transaction.
      const uniqueIds = Array.from(new Set(ids));

      // Scope check FIRST — silent cross-team drop. Cross-team +
      // missing ids are filtered out of the transaction and the
      // response envelope; HTTP stays 200 with a partial `results`
      // array. Same posture as /snooze-batch and /assign-owner-batch.
      // Selecting `snoozedUntil` so the snooze-arm filter below can
      // drop future-snoozed rows without a second round trip.
      const existing = await prisma.alert.findMany({
        where: { id: { in: uniqueIds }, teamId },
        select: { id: true, teamId: true, snoozedUntil: true },
      });
      const existingById = new Map(existing.map((row) => [row.id, row]));
      // Snooze-arm gate — drop rows with an ACTIVE snooze window
      // (`snoozedUntil > now`). Mirrors /resolve's branch: a
      // snoozed row stays re-triagable later.
      const activeNow = new Date();
      const liveIds: string[] = [];
      for (const id of uniqueIds) {
        const row = existingById.get(id);
        if (!row) continue; // cross-team / missing id — silent drop.
        if (row.snoozedUntil && row.snoozedUntil > activeNow) continue;
        liveIds.push(row.id);
      }

      // Single shared `now` for the whole batch — every flipped row
      // carries the same closedAt + statusChangedAt wall clock and,
      // when a note is supplied, every AlertNote.createdAt. An audit
      // reader can group flips from the same bulk action.
      const now = new Date();

      // Empty-live-ids short-circuit — caller selected nothing the
      // route can actually flip (every id was cross-team or
      // future-snoozed). Return `{results: []}` so the helper's
      // per-row outcome map trivially stamps 'ok' on every
      // candidate (an empty candidate set's `allOk` is true by
      // construction). The transaction is short-circuited so a 200
      // with no rows is the deliberate "nothing to do" success.
      if (liveIds.length === 0) {
        const empty = AlertBulkResolveBatchResponse.parse({ results: [] });
        return NextResponse.json(empty);
      }

      // Atomic write — one prisma.$transaction with a per-id fan-out
      // inside the callback form. The alert.update and the optional
      // alertNote.create run on the SAME transaction so a per-row
      // failure rolls the whole batch back. Each per-row update
      // selects the {id, teamId, status, statusChangedAt, closedAt,
      // closedBy} slice so the response envelope can be assembled
      // without a follow-up round trip and the defence-in-depth
      // teamId re-read can flag a tampered cross-team race.
      const updated = await prisma.$transaction(async (tx) => {
        const stamped: Array<{
          id: string;
          teamId: string;
          status: 'open' | 'in_progress' | 'resolved' | 'false_positive';
          statusChangedAt: Date | null;
          closedAt: Date | null;
          closedBy: string | null;
        }> = [];
        for (const id of liveIds) {
          const row = await tx.alert.update({
            where: { id },
            data: {
              status: 'resolved',
              statusChangedAt: now,
              closedAt: now,
              closedBy: ctx.user.id,
              closingNote: shouldInsertNote ? trimmedNote : null,
            },
            select: {
              id: true,
              teamId: true,
              status: true,
              statusChangedAt: true,
              closedAt: true,
              closedBy: true,
            },
          });
          stamped.push(row);
          if (shouldInsertNote) {
            // Insert one AlertNote row per resolved alert. The
            // bottom-of-page notes pane surfaces this on a follow-
            // up /api/alerts/[id]/notes read; the slim bulk
            // envelope does NOT round-trip the note rows (no email
            // dispatch — the bulk gesture is one round trip and N
            // emails would crowd a small operator inbox).
            await tx.alertNote.create({
              data: {
                alertId: id,
                authorUserId: ctx.user.id,
                body: trimmedNote,
              },
            });
          }
        }
        return stamped;
      });

      // Defence-in-depth — pact-defensive only. Should be
      // impossible after the scope-check filter: a tampered race
      // produced a cross-team row in the transaction result. Bail
      // to opaque 404 so the caller cannot distinguish that branch
      // from a real not_found (the resolve route's posture).
      for (const row of updated) {
        if (row && row.teamId !== teamId) {
          return NextResponse.json({ error: 'not_found' }, { status: 404 });
        }
      }

      // Per-result envelope via AlertBulkResolveBatchRow.parse —
      // slim `{id, status, statusChangedAt, closedAt, closedBy}` per
      // row. Mirrors AlertResolveResponse's close-stamp trio so the
      // helper's optimistic flip and a future refetch share the
      // same wire family without a second round trip. Order
      // mirrors the post-scope `liveIds` so the helper's per-id
      // outcome map can derive 'ok' / 'err' from a simple Map.has
      // lookup without re-sorting.
      const results = updated.map((row) =>
        AlertBulkResolveBatchRow.parse({
          id: row.id,
          status: row.status,
          statusChangedAt: row.statusChangedAt ? row.statusChangedAt.toISOString() : null,
          closedAt: row.closedAt ? row.closedAt.toISOString() : null,
          closedBy: row.closedBy ?? null,
        }),
      );

      const parsed = AlertBulkResolveBatchResponse.parse({ results });
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
