// @polsia:user-owned — POST /api/alerts/ownership-batch. Bulk stamp
// `Alert.ownerId = callerWorkspaceMember.id` on a batch of alert ids,
// one UPDATE per id. Sister to POST /api/alerts/snooze-batch (the
// atomic single-transaction companion) and to POST /api/alerts
// /[id]/claim (the single-id claim that ends in the same
// route-resolved owner). Behavioral deltas that drive the bulk
// gesture:
//
//   1. ONE UPDATE PER ID, NOT a single prisma.$transaction. The
//      brief's "per-id UPDATE" posture is deliberate — the
//      already-owned branch needs to surface per-id via the
//      `conflicts[]` envelope arm without dragging a partial
//      transaction into a rollback. A single transaction would
//      paper-over per-id failures by partial-rolling-back the
//      other writes; the route-level behavior we want is "every
//      id is either re-owned or reported as conflict, never
//      half-landed".
//
//   2. Scope check FIRST — single prisma.alert.findMany with
//      `where: { id: { in: uniqueIds }, teamId }`. Cross-team ids
//      are SILENTLY DROPPED from the working set (mirrors the
//      snooze-batch / remediate-batch cross-team posture): HTTP
//      stays 200, the response envelope just doesn't echo them.
//      Failing the whole batch on a single cross-team id would be
//      a worse UX — the operator almost certainly meant to claim
//      the in-team rows.
//
//   3. ALREADY-OWNED branch per id — a row whose `ownerId` already
//      equals the resolved caller WorkspaceMember.id is reported
//      into the `conflicts[]` envelope arm (NOT a 409, NOT a
//      failed[] arm). HTTP stays 200; the operator-facing UX
//      treats "you already own this" as a no-op success, not a
//      failure. The page's helper pre-filter drops already-owned
//      ids from the candidate set so a typical bulk-take
//      selection never produces conflicts; the surface here is
//      for a stale post-mount reassignment race (a picker change
//      landed after the page rendered the working set).
//
//   4. Caller WorkspaceMember is resolved server-side ONCE at the
//      top of the handler — no body-supplied `ownerId` ever
//      reaches a write. `requireTeamRole('member')` is the gate,
//      and the route peer-reads `WorkspaceMember.findFirst({
//      where: { userId, workspaceId, status: 'active' } })` so
//      the assignment target is always the caller's own active
//      roster row. Cross-team member-id write is impossible by
//      construction (no body FK + server-resolved caller identity).
//
//   5. `ownerName` is resolved server-side ONCE via
//      `prisma.user.findUnique({ where: { id: callerWorkspaceMember
//      .userId }, select: { name: true } })` so the optimistic
//      flip on /alerts stamps `ownerName` in lockstep with
//      `ownerId` without a follow-up round trip. Null on
//      `User.name` falls through to the route's mirror shape.
//
// Body contract:
//   - `ids` is a non-empty array of alert ids (`.min(1)` so an
//     empty selection 400s through; the page-side handler
//     pre-filters already-owned rows but the schema enforces it
//     server-side too).
//   - `.strict()` so an undisclosed caller field 400s through.
//   - No `ownerId` / no FK in the body — the assignment target is
//     the caller WorkspaceMember resolved from session.
//
// Fail-closed:
//   - Any throw inside the route → 500 JSON.

import 'server-only';
import { NextResponse } from 'next/server';
import {
  AlertBulkOwnershipBody,
  AlertBulkOwnershipConflict,
  AlertBulkOwnershipResponse,
  AlertBulkOwnershipRow,
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
      // /snooze-batch.
      let bodyInput: unknown = {};
      try {
        bodyInput = await req.json();
      } catch {
        return NextResponse.json(
          { error: 'bad_request', message: 'invalid JSON' },
          { status: 400 },
        );
      }
      const parsedBody = AlertBulkOwnershipBody.safeParse(bodyInput);
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

      // Resolve the caller's WorkspaceMember row ONCE — before the
      // per-id loop and before the scope check — so the route
      // peer-reads the roster exactly one time per request rather
      // than once per id. The 404 opaque posture mirrors
      // /remediate-batch and /[id]/claim: a missing roster row
      // shouldn't happen given `requireTeamRole` succeeded, but a
      // team bootstrap inconsistency is better surfaced than a 500.
      const callerWorkspaceMember = await prisma.workspaceMember.findFirst({
        where: { userId: ctx.user.id, workspaceId: teamId, status: 'active' },
        select: { id: true, userId: true },
      });
      if (!callerWorkspaceMember) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      // Resolve the caller's display name ONCE — peer-read
      // `prisma.user.findUnique` so the per-row response envelope
      // can carry `ownerName` authoritatively. `userId` is
      // nullable on the WorkspaceMember row while status
      // ='invited'; the active-status scope above already
      // guarantees userId is set on a bootstrap row, but the
      // route's TS narrowing still has to keep the peer-read
      // narrow. Null on a missing User.name — the optimistic
      // flip mirrors null through to the chip stack without a
      // follow-up round trip.
      const callerUser = callerWorkspaceMember.userId
        ? await prisma.user.findUnique({
            where: { id: callerWorkspaceMember.userId },
            select: { name: true },
          })
        : null;
      const callerName = callerUser?.name ?? null;

      // Scope check FIRST — single team-bounded findMany on the
      // unique request id set. Selects ONLY the columns the per-id
      // already-owned check + the per-id UPDATE need; the per-id
      // UPDATE below issues a fresh `update` per id.
      const existing = await prisma.alert.findMany({
        where: { id: { in: uniqueIds }, teamId },
        select: { id: true, teamId: true, ownerId: true },
      });
      // liveIds is the post-scope, team-bounded set. Every
      // subsequent iteration uses THIS set — NOT `uniqueIds`. A
      // cross-team id never reaches the per-id loop, the per-id
      // already-owned branch, or the response envelope. Silent
      // cross-team drop, NOT a 404, mirrors /snooze-batch and
      // /remediate-batch.
      const liveIds = existing.map((row) => row.id);

      const results: ReturnType<typeof AlertBulkOwnershipRow.parse>[] = [];
      const conflicts: ReturnType<typeof AlertBulkOwnershipConflict.parse>[] = [];

      // Build a per-id lookup off the scope-checked rows so the
      // loop below can rejoin `ownerId` without a second query.
      // Iterating `liveIds` keeps the canonical post-scope order so
      // the response envelope's `results` and `conflicts` arrays
      // mirror the request's team-bounded id order 1:1 — easier
      // for the helper's outcome map to derive 'ok' from set
      // lookups (id ∈ results ∪ conflicts === path → 'ok'; else
      // 'err').
      const existingById = new Map(existing.map((row) => [row.id, row]));
      for (const id of liveIds) {
        const row = existingById.get(id);
        if (!row) continue;
        // Per-id already-owned branch — a row whose `ownerId`
        // already equals the caller WorkspaceMember.id is
        // reported into `conflicts[]` (NOT an UPDATE, NOT a 409).
        // HTTP stays 200; the operator-facing UX treats "you
        // already own this" as a no-op success. The page's helper
        // pre-filter drops already-owned ids from the candidate
        // set so a typical bulk-take selection never produces
        // conflicts; the surface here is for a stale post-mount
        // reassignment race (a picker change landed after the
        // page rendered the working set).
        if (row.ownerId === callerWorkspaceMember.id) {
          conflicts.push(
            AlertBulkOwnershipConflict.parse({
              id: row.id,
              ownerId: callerWorkspaceMember.id,
            }),
          );
          continue;
        }
        // Per-id UPDATE — own implicit Prisma transaction. The
        // brief's "per-id UPDATE" posture is intentional: the
        // already-owned branch needs per-id ack/rollback on the
        // conflict arm, and a single prisma.$transaction across N
        // updates would NOT allow per-id result-vs-conflict
        // routing. Each update selects {id, teamId, ownerId} so
        // the response envelope can carry the freshly-stamped FK
        // and the defence-in-depth re-read can verify the teamId.
        const updated = await prisma.alert.update({
          where: { id: row.id },
          data: { ownerId: callerWorkspaceMember.id },
          select: { id: true, teamId: true, ownerId: true },
        });
        // Defence-in-depth — pact-defensive only. Should be
        // impossible after the scope-check filter: a tampered
        // race produced a cross-team row in the per-id write.
        // Bail to opaque 404 so the caller cannot distinguish
        // that branch from a real not_found (mirrors
        // /remediate-batch).
        if (updated.teamId !== teamId) {
          return NextResponse.json({ error: 'not_found' }, { status: 404 });
        }
        results.push(
          AlertBulkOwnershipRow.parse({
            id: updated.id,
            ownerId: updated.ownerId ?? callerWorkspaceMember.id,
            ownerName: callerName,
          }),
        );
      }

      const parsed = AlertBulkOwnershipResponse.parse({ results, conflicts });
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
