// @polsia:user-owned — POST /api/alerts/[id]/reopen. Inverse of the
// resolve mutation: idempotently flips Alert.status from 'resolved' (or
// 'in_progress' or 'false_positive') → 'open' and stamps statusChangedAt
// AND the reopen-stamp trio on the same write, gated by
// requireTeamRole('member'). The body schema is its own
// (`AlertReopenBody` — optional `reason` capped at 500 chars to
// mirror `AlertResolveBody.note`).
//
// Re-opening also CLEARS the operator-stamp trio in lockstep:
//   - `falsePositiveReason` — the suppression stamp from a prior
//     FP transition must NOT ride a triage flip forward.
//   - `closedAt` / `closedBy` / `closingNote` — the close-stamp
//     trio from a prior `resolved` transition. Reopening a resolved
//     row MUST NOT strand a stale close stamp; the row's chip is
//     driven by `status` alone (the trio is reset on the next
//     resolve, not preserved across reopens).
//   - And STAMPS the reopen-stamp trio: `reopenedAt` (server-time
//     wall clock), `reopenedBy` (`ctx.user.id` — the actor's scalar
//     FK on `User.id`), and `reopenReason` (the trimmed optional
//     reason; null when the body sends blank/whitespace-only).
//
// Access-control posture mirrors /resolve 1:1:
//   - 401 anon / 403 below-member — opaque, no existence leak via status.
//   - Cross-team id (or fully missing row) → opaque 404 BEFORE any write.
//   - findFirst above scopes by `where: { id, teamId }`, the UPDATE
//     targets the unique Alert.id, and a post-write teamId re-read
//     defends against a stale or compromised write landing on
//     another team's row.
//   - Idempotent: a re-open on an already-'open' row returns the same
//     envelope WITHOUT firing an UPDATE. The reopen trio
//     (`reopenedAt`/`reopenedBy`/`reopenReason`) is preserved
//     verbatim from disk on the idempotent branch so a stale click
//     doesn't churn the audit stamp.
//
// Fail-closed:
//   - Any throw inside the route → 500 JSON.

import 'server-only';
import { NextResponse } from 'next/server';
import { requireAlertWorkspaceMember } from '@/lib/business/alert-workspace-access';
import { AlertReopenBody, AlertResolveResponse } from '@/lib/contracts/alerts';
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
      // Body parse FIRST — a malformed body 400s BEFORE any DB read
      // and BEFORE the scope gate, mirroring the resolve + FP
      // routes. The `AlertReopenBody` schema enforces `.max(500)`
      // on `reason` and `.strict()` so future caller fields 400
      // through — parity with `AlertResolveBody` / `AlertFalsePositiveBody`.
      let bodyInput: unknown = {};
      try {
        bodyInput = await req.json();
      } catch {
        return NextResponse.json(
          { error: 'bad_request', message: 'invalid JSON' },
          { status: 400 },
        );
      }
      const parsedBody = AlertReopenBody.safeParse(bodyInput);
      if (!parsedBody.success) {
        return NextResponse.json(
          { error: 'bad_request', issues: parsedBody.error.flatten() },
          { status: 400 },
        );
      }
      // Server-side normalization — `.trim()` is already applied by
      // zod on the parsed value, but fall back to null on a blank
      // reason so the `reopenReason` column stores NULL (NOT an
      // empty string) and so the row stays easy to query. Trimming
      // is performed here so the trimmed string is what the
      // UPDATE writes and what the parsed envelope echoes.
      const trimmedReason = parsedBody.data.reason?.trim() ?? '';
      const reopenReasonValue = trimmedReason.length > 0 ? trimmedReason : null;

      // Scope check FIRST. Cross-team probing and missing rows resolve
      // to the same opaque 404 — no existence leak, no UPDATE.
      const existing = await prisma.alert.findFirst({
        where: { id, teamId },
        select: {
          id: true,
          status: true,
          statusChangedAt: true,
          acknowledgedAt: true,
          // Read falsePositiveReason so the response envelope can
          // re-stamp the cleared value after the write below.
          falsePositiveReason: true,
          // Read the close-stamp trio so the response envelope
          // echoes the cleared state on the response.
          closedAt: true,
          closedBy: true,
          closingNote: true,
          // Read the reopen-stamp trio so the idempotent
          // already-open branch can echo it back from disk —
          // preserved verbatim on a stale re-click.
          reopenedAt: true,
          reopenedBy: true,
          reopenReason: true,
        },
      });
      if (!existing) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      // Idempotent: a row already in 'open' returns the same envelope
      // WITHOUT firing an UPDATE — protects the column from being
      // churned with fresh statusChangedAt / reopenedAt stamps on a
      // stale click. The reopen trio reads back verbatim from disk
      // so a stale re-click NEVER churns the original audit stamp.
      // Reading via `?? null` keeps a future invariant bug — a row
      // somehow carrying a non-null close stamp while in 'open' —
      // visible on the wire instead of silently flattened to null.
      if (existing.status === 'open') {
        const parsed = AlertResolveResponse.parse({
          id: existing.id,
          status: existing.status,
          statusChangedAt: existing.statusChangedAt ? existing.statusChangedAt.toISOString() : null,
          acknowledgedAt: existing.acknowledgedAt ? existing.acknowledgedAt.toISOString() : null,
          closedAt: existing.closedAt ? existing.closedAt.toISOString() : null,
          closedBy: existing.closedBy ?? null,
          closingNote: existing.closingNote ?? null,
          reopenedAt: existing.reopenedAt ? existing.reopenedAt.toISOString() : null,
          reopenedBy: existing.reopenedBy ?? null,
          reopenReason: existing.reopenReason ?? null,
        });
        return NextResponse.json(parsed);
      }

      // Stamp statusChangedAt + the reopen trio + clear ALL
      // prior operator-stamp columns on the same write so a
      // re-open lands the row's "Resolved at …" / "Reason"
      // chips + the prior reopen stamp back to its previous
      // values. Scope-assert via findFirst above AND a
      // post-write teamId verify below.
      const reopenedAt = new Date();
      const updated = await prisma.alert.update({
        where: { id },
        data: {
          status: 'open',
          statusChangedAt: reopenedAt,
          falsePositiveReason: null,
          closedAt: null,
          closedBy: null,
          closingNote: null,
          reopenedAt,
          reopenedBy: ctx.user.id,
          reopenReason: reopenReasonValue,
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
          reopenedAt: true,
          reopenedBy: true,
          reopenReason: true,
        },
      });
      if (updated.teamId !== teamId) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      // ResolveResponse carries the reopen trio + close trio
      // alongside the earlier quartuple. The close trio reads
      // NULL after the write; the reopen trio echoes back the
      // server-stamped values (including the trimmed reason
      // when the body carried one).
      const parsed = AlertResolveResponse.parse({
        id: updated.id,
        status: updated.status,
        statusChangedAt: updated.statusChangedAt ? updated.statusChangedAt.toISOString() : null,
        acknowledgedAt: updated.acknowledgedAt ? updated.acknowledgedAt.toISOString() : null,
        closedAt: null,
        closedBy: null,
        closingNote: null,
        reopenedAt: updated.reopenedAt ? updated.reopenedAt.toISOString() : null,
        reopenedBy: updated.reopenedBy ?? null,
        reopenReason: updated.reopenReason ?? null,
      });
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
