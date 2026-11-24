// @polsia:user-owned — POST /api/alerts/remediate-batch. Bulk stamp
// `remediatedAt = now()` and `remediatedByEmail = callerEmail` on a
// batch of alert ids, one UPDATE per id. Sister to POST /api/alerts
// /snooze-batch (the atomic single-transaction companion) and to
// POST /api/alerts/[id]/remediate (the single-id owner-gated
// counterpart). Behavioral deltas that drive the bulk gesture:
//
//   1. ONE UPDATE PER ID, NOT a single prisma.$transaction. The
//      brief's "per-id transactions" posture is deliberate — a
//      per-id owner check (`existing.ownerId === callerWorkspaceMember
//      .id`) gates the stamp; an owner mismatch for row N cannot
//      surface 200 OK and somehow drag rows M ≠ N into a silent
//      stamp. A single transaction would paper-over per-id failures
//      by partial-rolling-back the other writes.
//
//   2. Scope check FIRST — single prisma.alert.findMany with
//      `where: { id: { in: uniqueIds }, teamId }`. Cross-team ids
//      are SILENTLY DROPPED from the working set (mirrors the
//      snooze-batch route of `/api/alerts/snooze-batch/route.ts`):
//      HTTP stays 200, the response envelope just doesn't echo
//      them. Failing the whole batch on a single cross-team id
//      would be a worse UX — the operator almost certainly meant
//      to stamp the in-team rows.
//
//   3. OWNER gate per id — only the assignee whose
//      `WorkspaceMember.id` is `Alert.ownerId` can stamp the row.
//      Strictly mirrors the single-id `/api/alerts/[id]/remediate`
//      PATCH. The per-id mismatch is reported into the response
//      envelope's `failed[]` arm (NOT a blanket 404) so the
//      page's per-row outcome map distinguishes not_owner from a
//      network/race failure.
//
//   4. Idempotent ALREADY-STAMPED branch — a re-remediate on a row
//      whose `remediatedAt !== null` returns the existing envelope
//      without an UPDATE. Preserves the original audit stamp on a
//      stale click race.
//
//   5. `remediatedByEmail` is stamped from the caller's resolved
//      `WorkspaceMember.email` (preferred — peer-read at the top
//      of the handler so we don't round-trip per id) or
//      `ctx.user.email` (fallback for the rare WorkspaceMember row
//      missing an email column — none today, but the route
//      tolerates it). Null on both → null on the row.
//
// Body contract:
//   - `ids` is a non-empty array of alert ids (`.min(1)` so an empty
//     selection 400s through; the page-side handler pre-filters
//     already-stamped rows but the schema enforces it server-side
//     too).
//   - `.strict()` so an undisclosed caller field 400s through.
//
// Fail-closed:
//   - Any throw inside the route → 500 JSON.

import 'server-only';
import { NextResponse } from 'next/server';
import {
  AlertBulkRemediateBody,
  AlertBulkRemediateResponse,
  AlertBulkRemediateRow,
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
      const parsedBody = AlertBulkRemediateBody.safeParse(bodyInput);
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

      // Resolve the caller's WorkspaceMember row + the caller email
      // ONCE — before the per-id loop — so the route peer-reads the
      // roster email exactly one time per request rather than once
      // per id. `email ?? user.email ?? null` so a stale roster
      // never lands `null`; the User row's email is the safe second
      // source (better-auth always seeds it). The owner gate below
      // short-circuits on the resolved `id`, so a missing roster
      // row surfaces an opaque 404 (mirrors the single-id remediate
      // route).
      const callerWorkspaceMember = await prisma.workspaceMember.findFirst({
        where: { userId: ctx.user.id, workspaceId: teamId, status: 'active' },
        select: { id: true, email: true },
      });
      if (!callerWorkspaceMember) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }
      const callerEmail = callerWorkspaceMember.email ?? ctx.user.email ?? null;

      // Scope check FIRST — single team-bounded findMany on the
      // unique request id set. Selects ONLY the columns the per-id
      // ownership check + the existing-stamp branch need; the
      // per-id UPDATE below issues a fresh `update` per id.
      const existing = await prisma.alert.findMany({
        where: { id: { in: uniqueIds }, teamId },
        select: { id: true, teamId: true, ownerId: true, remediatedAt: true },
      });
      // liveIds is the post-scope, team-bounded set. Every
      // subsequent iteration uses THIS set — NOT `uniqueIds`. A
      // cross-team id never reaches the per-id loop, the per-id
      // owner gate, or the response envelope. Silent cross-team
      // drop, NOT a 404, mirrors /snooze-batch.
      const liveIds = existing.map((row) => row.id);

      const results: ReturnType<typeof AlertBulkRemediateRow.parse>[] = [];
      const failed: Array<{ id: string; error: 'not_owner' }> = [];

      const stamp = new Date();
      // Build a per-id lookup off the scope-checked rows so the
      // loop below can rejoin owner / remediatedAt without a
      // second query. Iterating `liveIds` keeps the canonical
      // post-scope order so the response envelope's `results`
      // and `failed` arrays mirror the request's team-bounded id
      // order 1:1 — easier for the helper's outcome map to derive
      // 'ok' / 'err' from set lookups.
      const existingById = new Map(existing.map((row) => [row.id, row]));
      for (const id of liveIds) {
        const row = existingById.get(id);
        if (!row) continue;
        // Per-id idempotent branch — a re-remediate on a row whose
        // `remediatedAt !== null` returns the existing envelope
        // without an UPDATE. Preserves the ORIGINAL audit stamp on
        // a stale click race (e.g. an operator double-clicks "Mark
        // remediated" across two windows). The bulk route does NOT
        // churn `remediatedAt` for already-stamped rows.
        if (row.remediatedAt !== null) {
          results.push(
            AlertBulkRemediateRow.parse({
              id: row.id,
              remediatedAt: row.remediatedAt.toISOString(),
            }),
          );
          continue;
        }
        // Per-id owner gate — strictly mirrors the single-id
        // `[id]/remediate` PATCH: only the assignee whose
        // `WorkspaceMember.id` is currently `Alert.ownerId` can
        // stamp the row. A stale reassignment (picker reassigned
        // the alert between page mount and click) lands on the
        // `failed` envelope — NOT a silent stamp, NOT a blanket
        // 404. The page's per-row outcome map paints the indicator
        // chip 'err' on the not_owner branch uniformly with a
        // network / schema failure.
        if (row.ownerId !== callerWorkspaceMember.id) {
          failed.push({ id: row.id, error: 'not_owner' });
          continue;
        }
        // Per-id UPDATE — own implicit Prisma transaction. The
        // brief's "per-id transactions" posture is intentional: a
        // per-id owner check gates the stamp, and a single
        // prisma.$transaction across N updates would NOT allow
        // per-id ack/rollback on the owner-mismatch arm. Each
        // update selects the {id, teamId, remediatedAt} trio so the
        // response envelope can carry the freshly-stamped ISO
        // string and the defence-in-depth re-read can verify the
        // teamId.
        const updated = await prisma.alert.update({
          where: { id: row.id },
          data: { remediatedAt: stamp, remediatedByEmail: callerEmail },
          select: { id: true, teamId: true, remediatedAt: true },
        });
        // Defence-in-depth — pact-defensive only. Should be
        // impossible after the scope-check filter: a tampered race
        // produced a cross-team row in the per-id write. Bail to
        // opaque 404 so the caller cannot distinguish that branch
        // from a real not_found (mirrors `[id]/remediate` PATCH).
        if (updated.teamId !== teamId) {
          return NextResponse.json({ error: 'not_found' }, { status: 404 });
        }
        results.push(
          AlertBulkRemediateRow.parse({
            id: updated.id,
            remediatedAt: updated.remediatedAt ? updated.remediatedAt.toISOString() : null,
          }),
        );
      }

      const parsed = AlertBulkRemediateResponse.parse({ results, failed });
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
