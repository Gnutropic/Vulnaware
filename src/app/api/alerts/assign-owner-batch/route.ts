// @polsia:user-owned — POST /api/alerts/assign-owner-batch. Bulk stamp
// `Alert.ownerId = <picked>` on a batch of alert ids in a single
// `prisma.$transaction`. Sister to POST /api/alerts/snooze-batch
// (the atomic single-transaction companion) and to POST /api/alerts
// /ownership-batch (the per-id "take ownership" companion that
// resolves the target from session). Behavioral deltas that drive
// the bulk-assign-owner gesture:
//
//   1. ONE transaction (one `prisma.$transaction`) so the write is
//      all-or-nothing — a 4xx/5xx on row N leaves rows M ≠ N in
//      their pre-batch state. Per-id fan-out via Promise.allSettled
//      (the posture the existing per-id bulk routes get) is NOT
//      atomic at the DB level; the bulk endpoint closes that gap.
//      Mirrors POST /api/alerts/snooze-batch verbatim.
//
//   2. Scope check FIRST — single `prisma.alert.findMany` with
//      `where: { id: { in: uniqueIds }, teamId }`. Cross-team ids
//      are SILENTLY DROPPED from both the transaction and the
//      response envelope. HTTP stays 200 with a partial `results`
//      array — the same posture `/snooze-batch` uses (the explicit
//      divergence from POST /api/alerts/resolve's opaque-404).
//
//   3. Snooze-arm gate — rows whose `snoozedUntil > now` are
//      silently skipped from both the transaction AND the
//      response envelope. Mirrors /claim's posture: a snoozed
//      row stays re-triagable later, the bulk gesture never
//      stamps over an active snooze.
//
//   4. FK validation MIRROR PATCH /[id]/owner — a non-null
//      `ownerId` MUST resolve to an active WorkspaceMember row in
//      this team. Cross-team / foreign-workspace ids are rejected
//      with 400 + `{errors: {ownerId: '…'}}` (NOT opaque 404)
//      because the input came from a picker the caller just
//      rendered — no probing path.
//
//   5. `ownerName` is resolved server-side ONCE per request via
//      `WorkspaceMember.findFirst` + `User.findUnique` so the
//      optimistic flip on /alerts can stamp `ownerName` in
//      lockstep with `ownerId` without a follow-up round trip.
//
// Body contract:
//   - `ids` is a non-empty array of alert ids (`.min(1)`).
//   - `ownerId` is the picked member FK or `null` for "Unassigned".
//   - `.strict()` so an undisclosed caller field 400s through.
//
// Fail-closed:
//   - Any throw inside the route → 500 JSON.

import 'server-only';
import { NextResponse } from 'next/server';
import {
  AlertBulkAssignOwnerBody,
  AlertBulkAssignOwnerResponse,
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
      // Body parse FIRST — malformed JSON 400s BEFORE the FK
      // validation so the schema validation sits ahead of any DB
      // read. Mirror of POST /snooze-batch and
      // /ownership-batch.
      let bodyInput: unknown = {};
      try {
        bodyInput = await req.json();
      } catch {
        return NextResponse.json(
          { error: 'bad_request', message: 'invalid JSON' },
          { status: 400 },
        );
      }
      const parsedBody = AlertBulkAssignOwnerBody.safeParse(bodyInput);
      if (!parsedBody.success) {
        return NextResponse.json(
          { error: 'bad_request', issues: parsedBody.error.flatten() },
          { status: 400 },
        );
      }
      const { ids, ownerId } = parsedBody.data;

      // Dedup the request id set so a caller posting duplicate ids
      // (manual selection + a stale `?selected=` URL preload, for
      // example) does not double-charge the scope gate.
      const uniqueIds = Array.from(new Set(ids));

      // FK validation mirror PATCH /[id]/owner. A non-null
      // `ownerId` MUST resolve to an active WorkspaceMember row in
      // this team; the caller just rendered the picker, so a
      // cross-team id is a mis-click and a 400 + `{errors:
      // {ownerId: '…'}}` (NOT a 404 — no probing path).
      let resolvedOwnerName: string | null = null;
      if (ownerId !== null) {
        const member = await prisma.workspaceMember.findFirst({
          where: { id: ownerId, workspaceId: teamId, status: 'active' },
          select: { id: true, userId: true, email: true },
        });
        if (!member) {
          return NextResponse.json(
            {
              errors: {
                ownerId: 'The selected option is not an active member of this workspace.',
              },
            },
            { status: 400 },
          );
        }
        // Resolve `ownerName` ONCE — peer-read
        // `prisma.user.findUnique` so the optimistic flip can
        // stamp `ownerName` onto every targeted row without a
        // follow-up round trip.
        if (member.userId) {
          const u = await prisma.user.findUnique({
            where: { id: member.userId },
            select: { name: true },
          });
          resolvedOwnerName = u?.name ?? null;
        }
      }

      // Scope check FIRST — single team-bounded findMany. We
      // select `snoozedUntil` too so the snooze-arm gate below
      // can partition the live set without an extra round trip.
      const existing = await prisma.alert.findMany({
        where: { id: { in: uniqueIds }, teamId },
        select: { id: true, teamId: true, snoozedUntil: true },
      });

      // Snooze-arm gate — drop rows with an ACTIVE snooze window
      // (`snoozedUntil > now`). Elapsed snoozes (snoozedUntil <=
      // now) are NOT dropped — they read like a no-snooze row.
      const now = Date.now();
      const liveIds: string[] = [];
      for (const row of existing) {
        if (row.snoozedUntil && row.snoozedUntil.getTime() > now) continue;
        liveIds.push(row.id);
      }

      // Atomic write — a single `prisma.$transaction` that fans
      // out across the live (non-cross-team, non-snoozed) ids.
      // `ownerId: null` on a "Unassigned" body clears the FK;
      // `ownerId` set to the picker's FK stamps the new owner.
      const updated =
        liveIds.length === 0
          ? []
          : await prisma.$transaction(
              liveIds.map((id) =>
                prisma.alert.update({
                  where: { id },
                  data: { ownerId },
                  select: { id: true, teamId: true, ownerId: true },
                }),
              ),
            );

      // Defence-in-depth — pact-defensive only. Should be
      // impossible after the scope-check filter: a tampered race
      // produced a cross-team row in the transaction result.
      // Bail to opaque 404 so the caller cannot distinguish that
      // branch from a real not_found.
      for (const row of updated) {
        if (row.teamId !== teamId) {
          return NextResponse.json({ error: 'not_found' }, { status: 404 });
        }
      }

      // Per-result envelope via `AlertBulkOwnershipRow.parse` —
      // re-uses the same slim `{id, ownerId, ownerName}` row the
      // /ownership-batch route already stamps. The "Unassigned"
      // arm (`ownerId === null` in the body) clears the FK on
      // every row but does NOT echo rows back through `results`:
      // `AlertBulkOwnershipRow.ownerId` is a non-null literal
      // pinned to the /ownership-batch wire contract, so a
      // cleared row would either be filtered by the .parse()
      // call or carry a meaningless sentinel. The FK IS still
      // cleared on every row.
      const results =
        ownerId === null
          ? []
          : updated.map((row) =>
              AlertBulkOwnershipRow.parse({
                id: row.id,
                ownerId: row.ownerId ?? ownerId,
                ownerName: resolvedOwnerName,
              }),
            );

      const parsed = AlertBulkAssignOwnerResponse.parse({ results });
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
