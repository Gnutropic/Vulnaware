// @polsia:user-owned — POST /api/alerts/resolve. Atomic bulk-resolve
// endpoint that resolves a batch of alert ids in a single transaction.
// Companion to POST /api/alerts/[id]/resolve (the per-row composer
// still uses the single-id route), but with three architectural deltas
// that drive the bulk action:
//
//   1. ONE transaction (one prisma.$transaction) so the write is
//      all-or-nothing — a 4xx/5xx on row N leaves rows M ≠ N in their
//      pre-batch state. The fan-out posture on the page side used
//      Promise.allSettled for the single-id route, which is NOT
//      atomic at the DB level: a partial failure could leave rows in
//      mixed states. The bulk endpoint closes that gap.
//
//   2. Scope check FIRST — a single prisma.alert.findMany with
//      `where: { id: { in: ids }, teamId }`. If the returned id set
//      doesn't match the requested id set (cross-team probing,
//      missing ids, or duplicate ids in the request), the route
//      rejects with an opaque 404 BEFORE any write fires. The
//      cross-team / missing-id pair is intentionally indistinguishable
//      to the caller so existence is not leaked across teams.
//
//   3. Per-id write paths mirror the single-id route's invariants so
//      the bulk and single-id surfaces produce structurally aligned
//      envelopes — the helper's optimistic flip map and the
//      future-detail refetch can run the same parse against either
//      response:
//      - First-write transition ('open' / 'in_progress' /
//        'false_positive' → 'resolved'): status + statusChangedAt +
//        closedAt + closedBy + (optional) closingNote on the same
//        UPDATE. StatusChangedAt and closedAt share a single `now`
//        across the batch so every flipped row stamps the same wall
//        clock — easier auditing for a bulk action.
//      - Re-resolve on an already-resolved row, NO note: skip — the
//        idempotent-already-resolved branch. Returns the on-disk state
//        without firing an UPDATE so a stale click never churns
//        statusChangedAt / closedAt / closedBy on rows that are
//        already closed.
//      - Re-resolve on an already-resolved row WITH a non-blank note:
//        partial UPDATE only `closingNote` + `statusChangedAt` — the
//        close-stamp trio's `closedAt`/`closedBy` (which encode
//        first-write identity) are NEVER overwritten, parity with the
//        single-id route's re-resolve-with-note branch.
//
// Body contract:
//   - `ids` is a non-empty array of alert ids (min(1) so an empty
//     selection 400s through — the page-side dialog never sends an
//     empty batch, but the schema enforces it server-side too).
//   - `note` is OPTIONAL, 0–500 chars after trim. Blank/whitespace-
//     only collapses to NULL on every row that flips.
//   - `.strict()` so an undisclosed caller field 400s through.
//
// Fail-closed:
//   - Any throw inside the route → 500 JSON.

import 'server-only';
import { NextResponse } from 'next/server';
import {
  AlertBulkResolveBody,
  AlertBulkResolveResponse,
  AlertResolveResponse,
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
      // so the schema validation sits ahead of any DB read. The
      // AlertBulkResolveBody schema enforces `.min(1)` on `ids`,
      // `.max(500)` on `note`, and `.strict()` so a future caller
      // field 400s through.
      let bodyInput: unknown = {};
      try {
        bodyInput = await req.json();
      } catch {
        return NextResponse.json(
          { error: 'bad_request', message: 'invalid JSON' },
          { status: 400 },
        );
      }
      const parsedBody = AlertBulkResolveBody.safeParse(bodyInput);
      if (!parsedBody.success) {
        return NextResponse.json(
          { error: 'bad_request', issues: parsedBody.error.flatten() },
          { status: 400 },
        );
      }
      const { ids } = parsedBody.data;
      const trimmedNote = parsedBody.data.note?.trim() ?? '';
      const closingNoteValue: string | null = trimmedNote.length > 0 ? trimmedNote : null;

      // Scope check FIRST. Cross-team ids + missing ids + duplicate
      // ids collapse to the same opaque 404 — no existence leak
      // across teams, no half-visible partial-write state. The id
      // set comparison uses Set semantics so a request with duplicate
      // ids (e.g. `['a', 'a', 'b']`) resolves to the same opaque 404
      // as a missing-id request.
      const uniqueIds = Array.from(new Set(ids));
      const existing = await prisma.alert.findMany({
        where: { id: { in: uniqueIds }, teamId },
        select: {
          id: true,
          status: true,
          statusChangedAt: true,
          acknowledgedAt: true,
          closedAt: true,
          closedBy: true,
          closingNote: true,
          reopenedAt: true,
          reopenedBy: true,
          reopenReason: true,
          // Snooze-arm filter on the transaction below. Selecting the
          // column up-front so the in-memory OR-clause can drop future
          // snoozed rows without a second round trip.
          snoozedUntil: true,
        },
      });
      if (existing.length !== uniqueIds.length) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      // Snooze-arm gate — silently drop rows whose snooze window is
      // still in the future. Per the brief, snoozed alerts remain
      // re-triagable later; the bulk-resolve path therefore treats them
      // as out of scope (no transaction write, no envelope entry) so
      // the operator's Natural "Resolved selected" gesture does not
      // stamp a close trio over an active snooze. Elapsed snoozes
      // (snoozedUntil <= now) flow through unchanged so a re-visit
      // after a snooze elapses naturally falls back into the bulk
      // path.
      const activeNow = new Date();
      const liveExisting = existing.filter(
        (row) => row.snoozedUntil == null || row.snoozedUntil <= activeNow,
      );

      // Single shared `now` for the whole batch — every flipped row
      // carries the same closedAt + statusChangedAt wall clock so an
      // audit reader can group flips from the same bulk action at a
      // glance.
      const now = new Date();

      // Atomic write — one prisma.$transaction. The route's invariants
      // for each row mirror the single-id /resolve route:
      //   - resolved + note == null → no UPDATE (idempotent no-op)
      //   - resolved + note != null → partial UPDATE on closingNote +
      //     statusChangedAt (preserves first-write close-stamp trio)
      //   - open | in_progress | false_positive → first-write UPDATE
      //     stamps status + statusChangedAt + closedAt + closedBy +
      //     (optional) closingNote on the same row.
      //
      // Snoozed (future-window) rows have already been silently
      // dropped into `liveExisting` above; they receive neither a
      // transaction write NOR an envelope entry — the response
      // echoes only the ids the route actually flipped.
      const updated = await prisma.$transaction(
        liveExisting.map((row) => {
          if (row.status === 'resolved') {
            // Idempotent-already-resolved branch. Skip if the
            // request carries no note (preserve first-write
            // idempotence — a stale click must NOT churn the closed
            // trio). Otherwise fire a partial UPDATE only.
            if (closingNoteValue == null) {
              return prisma.alert.findUnique({
                where: { id: row.id },
                select: {
                  id: true,
                  status: true,
                  statusChangedAt: true,
                  acknowledgedAt: true,
                  closedAt: true,
                  closedBy: true,
                  closingNote: true,
                  reopenedAt: true,
                  reopenedBy: true,
                  reopenReason: true,
                },
              });
            }
            return prisma.alert.update({
              where: { id: row.id },
              data: {
                statusChangedAt: now,
                closingNote: closingNoteValue,
              },
              select: {
                id: true,
                teamId: true,
                status: true,
                statusChangedAt: true,
                acknowledgedAt: true,
                closedAt: true,
                closedBy: true,
                closingNote: true,
                reopenedAt: true,
                reopenedBy: true,
                reopenReason: true,
              },
            });
          }
          // First-write transition from open | in_progress |
          // false_positive → 'resolved'. Stamp all of status,
          // statusChangedAt, closedAt, closedBy, (optional)
          // closingNote on the same write.
          return prisma.alert.update({
            where: { id: row.id },
            data: {
              status: 'resolved',
              statusChangedAt: now,
              closedAt: now,
              closedBy: ctx.user.id,
              closingNote: closingNoteValue,
            },
            select: {
              id: true,
              teamId: true,
              status: true,
              statusChangedAt: true,
              acknowledgedAt: true,
              closedAt: true,
              closedBy: true,
              closingNote: true,
              reopenedAt: true,
              reopenedBy: true,
              reopenReason: true,
            },
          });
        }),
      );

      // Defence-in-depth: a tampered race produced a cross-team
      // write on any row — bail to opaque 404.
      for (const row of updated) {
        if (row && 'teamId' in row && row.teamId !== teamId) {
          return NextResponse.json({ error: 'not_found' }, { status: 404 });
        }
      }

      // Per-result envelope via AlertResolveResponse.parse — round-
      // trip the same wire shape the single-id route returns so the
      // page's optimistic flip + future refetch share the contract.
      // Ids missing from `updated` (shouldn't happen, pact-defensive)
      // are filtered out.
      const byId = new Map(
        updated
          .filter((row): row is NonNullable<typeof row> => row != null)
          .map((row) => [row.id, row]),
      );
      const results = uniqueIds
        .filter((id) => byId.has(id))
        .map((id) => {
          const row = byId.get(id);
          if (!row) throw new Error('envelope drift');
          return AlertResolveResponse.parse({
            id: row.id,
            status: row.status,
            statusChangedAt: row.statusChangedAt ? row.statusChangedAt.toISOString() : null,
            acknowledgedAt: row.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
            closedAt: row.closedAt ? row.closedAt.toISOString() : null,
            closedBy: row.closedBy ?? null,
            closingNote: row.closingNote ?? null,
            reopenedAt: row.reopenedAt ? row.reopenedAt.toISOString() : null,
            reopenedBy: row.reopenedBy ?? null,
            reopenReason: row.reopenReason ?? null,
          });
        });

      const parsed = AlertBulkResolveResponse.parse({ results });
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
