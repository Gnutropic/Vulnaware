// @polsia:user-owned — POST /api/alerts/[id]/false-positive. Idempotent
// transition of Alert.status to 'false_positive' with a server-validated
// reason (1–500 chars). Gated by requireTeamRole('member'); mirrors
// the sibling /resolve and /reopen posture 1:1:
//
//   - 401 anon / 403 below-member — opaque, no existence leak via status.
//   - Cross-team id (or fully missing row) → opaque 404 BEFORE any write.
//   - findFirst above scopes by `where: { id, teamId }`, the UPDATE
//     targets the unique Alert.id (Prisma cannot key update by the
//     non-unique `{ id, teamId }` pair), and a post-write teamId
//     re-read defends against a stale or compromised write landing on
//     another team's row.
//   - Idempotent on status: a row already in 'false_positive' returns
//     the same envelope WITHOUT firing an UPDATE — protects the
//     column from being churned with fresh statusChangedAt stamps on a
//     stale click.
//   - Self-clears the reason on a re-open (handled in /reopen, not
//     here — the inverse direction lives there).
//
// Fail-closed:
//   - Any throw inside the route → 500 JSON.

import 'server-only';
import { NextResponse } from 'next/server';
import { requireAlertWorkspaceMember } from '@/lib/business/alert-workspace-access';
import { AlertFalsePositiveBody, AlertFalsePositiveResponse } from '@/lib/contracts/alerts';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiRequest(req, async () => {
    let ctx: Awaited<ReturnType<typeof requireAlertWorkspaceMember>>;
    try {
      ctx = await requireAlertWorkspaceMember(req);
    } catch (res) {
      return res as Response;
    }

    setRequestAuth({ userId: ctx.user.id, teamId: ctx.workspaceId });

    const { id } = await params;
    const teamId = ctx.workspaceId;

    try {
      // Body parse FIRST — a malformed reason (empty, whitespace-only,
      // or >500 chars) 400s through BEFORE any DB read so the schema
      // validation sits ahead of the scope gate. The AlertFalsePositiveBody
      // zod schema enforces the same 1..500 char bound both client-side
      // (textarea maxLength mirror) and server-side (zod max(500)) — the
      // VARCHAR(500) DB cap echoes that upper bound so a malformed client
      // that bypasses zod hits an INSERT-level rejection, not a stored
      // multi-column reason.
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return NextResponse.json(
          { error: 'bad_request', message: 'invalid JSON' },
          { status: 400 },
        );
      }
      const parsed = AlertFalsePositiveBody.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json(
          { error: 'bad_request', issues: parsed.error.flatten() },
          { status: 400 },
        );
      }
      const reason = parsed.data.reason;

      // Scope check FIRST. Cross-team probing and missing rows resolve
      // to the same opaque 404 — no existence leak, no UPDATE.
      const existing = await prisma.alert.findFirst({
        where: { id, teamId },
        select: {
          id: true,
          status: true,
          statusChangedAt: true,
          acknowledgedAt: true,
          falsePositiveReason: true,
          // Read the close-stamp trio so the response envelope
          // echoes the (typically null) values: an FP row that was
          // last transitioned through resolve will carry a stale
          // close stamp until the next transition clears it. The
          // FP route does NOT clear the trio (only reopen does), so
          // a `resolved → false_positive` edge case round-trips the
          // trio values verbatim through this envelope.
          closedAt: true,
          closedBy: true,
          closingNote: true,
        },
      });
      if (!existing) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      // Idempotent: a row already in 'false_positive' returns the same
      // envelope WITHOUT firing an UPDATE — protects the column from
      // being churned with fresh statusChangedAt stamps on a stale
      // click (mirrors the /resolve and /reopen idempotent-already-state
      // branches). The UI also gates the row-level button on
      // status !== 'false_positive' so in practice this branch is
      // reached only via a stale in-flight click; the route still
      // ratifies that posture here.
      if (existing.status === 'false_positive') {
        const response = AlertFalsePositiveResponse.parse({
          id: existing.id,
          status: existing.status,
          statusChangedAt: existing.statusChangedAt ? existing.statusChangedAt.toISOString() : null,
          acknowledgedAt: existing.acknowledgedAt ? existing.acknowledgedAt.toISOString() : null,
          // Close-stamp trio entries — typically null on an FP row,
          // but a row flipped `resolved → false_positive` carries
          // the trio values verbatim until the next transition
          // clears them.
          closedAt: existing.closedAt ? existing.closedAt.toISOString() : null,
          closedBy: existing.closedBy ?? null,
          closingNote: existing.closingNote ?? null,
          falsePositiveReason: existing.falsePositiveReason,
        });
        return NextResponse.json(response);
      }

      // Stamp all four columns on the same write. Scope-assert via
      // findFirst above AND a post-write teamId verify below — mirrors
      // the sibling resolve / reopen posture. The FP transition
      // intentionally does NOT clear the close-stamp trio: the
      // trio belongs to `resolved`, and the reopen path is the
      // canonical "clear everything" branch. A re-resolve on an
      // FP-flipped-from-resolve row will preserve the trio's
      // first-write identity intact.
      const updated = await prisma.alert.update({
        where: { id },
        data: {
          status: 'false_positive',
          statusChangedAt: new Date(),
          falsePositiveReason: reason,
        },
        select: {
          id: true,
          teamId: true,
          status: true,
          statusChangedAt: true,
          acknowledgedAt: true,
          falsePositiveReason: true,
          closedAt: true,
          closedBy: true,
          closingNote: true,
        },
      });
      if (updated.teamId !== teamId) {
        // Defence-in-depth verification: a tampered race produced a
        // cross-team write. Treat as the opaque not_found so the FP
        // mutex holds.
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      const response = AlertFalsePositiveResponse.parse({
        id: updated.id,
        status: updated.status,
        statusChangedAt: updated.statusChangedAt ? updated.statusChangedAt.toISOString() : null,
        acknowledgedAt: updated.acknowledgedAt ? updated.acknowledgedAt.toISOString() : null,
        // Close-stamp trio echoed from the updated row — same posture
        // as the idempotent branch above.
        closedAt: updated.closedAt ? updated.closedAt.toISOString() : null,
        closedBy: updated.closedBy ?? null,
        closingNote: updated.closingNote ?? null,
        falsePositiveReason: updated.falsePositiveReason ?? null,
      });
      return NextResponse.json(response);
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
