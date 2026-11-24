// @polsia:user-owned — PATCH /api/alerts/[id]/remediate. Stamps or
// clears the per-alert `remediatedAt` operator stamp on the alert
// detail page. The endpoint is OWNER-gated: only the team member
// whose `WorkspaceMember.id` is currently `Alert.ownerId` is
// permitted to flip the flag. Stricter than the `resolved` /
// `false_positive` / `reopen` transitions (those are member-gated)
// — we want the stamp to reflect the assignee's manual
// confirmation, not a delegated handoff.
//
// Wire shape (PATCH body): `{ set: 'now' }` or `{ set: 'clear' }` —
// a discriminated union keeps a future caller shape 400ing through
// the contract rather than silently accepting arbitrary keys. The
// response envelope is a slim quintuple: just `{ id, remediatedAt }`,
// the same columns the parent detail GET stamps on the full
// `AlertDetail` envelope.
//
// Idempotent:
//   - `set: 'now'` on an already-stamped row returns the existing
//     envelope without an UPDATE — preserves the original audit
//     stamp on a stale click race.
//   - `set: 'clear'` on an unremediated row returns the existing
//     envelope without an UPDATE — same posture, opposite direction.
//
// Access-control posture (mirror [id]/reopen + [id]/owner):
//   - 401 anon / 403 below-member — opaque, no existence leak via
//     status. Wrapped in try/catch (`return res as Response;`) so
//     the gate's response reaches the client verbatim.
//   - Cross-team id (or fully missing row) → opaque 404 BEFORE any
//     write. `findFirst` above scopes by `where: { id, teamId }`,
//     the UPDATE targets the unique Alert.id, and a post-write
//     teamId re-read defends against a stale or compromised write
//     landing on another team's row.
//   - Identifier alignment: `Alert.ownerId` is a scalar FK onto
//     `WorkspaceMember.id` (NOT `Membership.id`), per the
//     `@polsia:user-owned` posture stamped on the schema. The
//     ownership gate looks up the caller's `WorkspaceMember.id` for
//     the team so the comparison is type-aligned (mirror of the
//     `me.isAssignee` resolution on GET /api/alerts/[id]). A stale
//     click race (a teammate reassigned the alert to someone else
//     while the page was mounted) lands on `403 not_owner` rather
//     than a silent stamp.
//   - Fail-closed: any throw inside the route → 500 JSON.

import 'server-only';
import { NextResponse } from 'next/server';
import { requireAlertWorkspaceMember } from '@/lib/business/alert-workspace-access';
import { AlertRemediateBody, AlertRemediateResponse } from '@/lib/contracts/alerts';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';

export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
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

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ error: 'bad_request', message: 'invalid JSON' }, { status: 400 });
    }
    const parsedBody = AlertRemediateBody.safeParse(raw);
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: 'bad_request', issues: parsedBody.error.flatten() },
        { status: 400 },
      );
    }

    try {
      // Resolve the caller's WorkspaceMember.id for the current team
      // so the ownership comparison is type-aligned with
      // `Alert.ownerId` — the column is a scalar FK onto
      // WorkspaceMember.id, NOT Membership.id, per the
      // @polsia:user-owned invariant on `model Alert` in
      // prisma/schema/alerts.prisma. Defensive 404 if missing —
      // shouldn't happen after `requireTeamRole`, but a team
      // bootstrap inconsistency is better surfaced than a 500.
      const callerWorkspaceMember = await prisma.workspaceMember.findFirst({
        where: { userId: ctx.user.id, workspaceId: teamId, status: 'active' },
        select: { id: true },
      });
      if (!callerWorkspaceMember) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      // Scope check FIRST. Cross-team probing and missing rows
      // resolve to the same opaque 404 — no existence leak, no
      // UPDATE. `existing.ownerId` reads off `Alert.ownerId` so
      // the ownership comparison below is type-aligned
      // (WorkspaceMember.id === WorkspaceMember.id).
      const existing = await prisma.alert.findFirst({
        where: { id, teamId },
        select: { id: true, ownerId: true, remediatedAt: true },
      });
      if (!existing) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      // Ownership gate: stricter than the team-member gate — only
      // the assignee can flip the flag. Mirror of `me.isAssignee`
      // on GET /api/alerts/[id]. A stale click race (picker
      // reassigned the alert while this page was mounted) lands on
      // `403 not_owner`, NOT a silent stamp.
      if (existing.ownerId !== callerWorkspaceMember.id) {
        return NextResponse.json({ error: 'not_owner' }, { status: 403 });
      }

      // Idempotent branches: a re-remediate on an already-stamped
      // row returns the existing envelope without an UPDATE; a
      // re-clear on an unremediated row returns the same envelope.
      // Preserves the original audit stamp on a stale click race
      // (the worst stale-click failure is a churn in
      // `remediatedAt`, which would silently overwrite the previous
      // fix-confirmation timestamp — so a no-OP response keeps the
      // operator's audit trail stable).
      if (parsedBody.data.set === 'now' && existing.remediatedAt !== null) {
        return NextResponse.json(
          AlertRemediateResponse.parse({
            id: existing.id,
            remediatedAt: existing.remediatedAt.toISOString(),
          }),
        );
      }
      if (parsedBody.data.set === 'clear' && existing.remediatedAt === null) {
        return NextResponse.json(
          AlertRemediateResponse.parse({
            id: existing.id,
            remediatedAt: null,
          }),
        );
      }

      // Stamp `Date.now()` server-side rather than trusting the
      // caller's optimistic Date.toISOString() — the server is the
      // authoritative timestamp source, the optimistic flip
      // reconciles against this on success.
      const newRemediatedAt = parsedBody.data.set === 'now' ? new Date() : null;
      const updated = await prisma.alert.update({
        where: { id },
        data: { remediatedAt: newRemediatedAt },
        select: { id: true, teamId: true, remediatedAt: true },
      });
      if (updated.teamId !== teamId) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      return NextResponse.json(
        AlertRemediateResponse.parse({
          id: updated.id,
          remediatedAt: updated.remediatedAt ? updated.remediatedAt.toISOString() : null,
        }),
      );
    } catch {
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  });
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'PATCH' } },
  );
}

export const GET = methodNotAllowed;
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const DELETE = methodNotAllowed;
