// @polsia:user-owned — POST /api/alerts/[id]/resolve. Idempotent
// transition of Alert.status to 'resolved'. Stamps statusChangedAt +
// the close-stamp trio (closedAt, closedBy, closingNote) on the same
// write, gated by the selected workspace's active WorkspaceMember.
//
// Body contract:
//   - Optional `note` (1–500 chars after trim) stamps onto
//     `Alert.closingNote`. Blank resolves are valid — `closingNote`
//     stores NULL on the row.
//   - `.strict()` so an unexpected future caller key 400s through.
//
// Access-control posture mirrors the canonical alert-detail GET route:
//   - Body parse FIRST — malformed body 400s before any DB read.
//   - 401 anon / no active selected workspace-member → opaque denial.
//   - Cross-workspace id (or fully missing row) → opaque 404 BEFORE any write.
//   - findFirst above scopes by `where: { id, teamId: workspaceId }`, the UPDATE
//     targets the unique Alert.id (Prisma cannot key update by the
//     non-unique `{ id, teamId }` pair), and a post-write teamId
//     re-read defends against a stale or compromised write landing on
//     another team's row.
//   - Idempotent on the FIRST-write path: re-resolve on an already-
//     resolved row returns the same envelope WITHOUT firing an UPDATE
//     (a stale click MUST NOT churn statusChangedAt / closedAt /
//     closedBy). A re-resolve WITH a fresh `note` does update — only
//     `closingNote` + `statusChangedAt`, never the close-stamp trio's
//     `closedAt`/`closedBy` (those stamp once on first resolve).
//
// Fail-closed:
//   - Any throw inside the route → 500 JSON.

import 'server-only';
import { NextResponse } from 'next/server';
import { requireAlertWorkspaceMember } from '@/lib/business/alert-workspace-access';
import { AlertResolveBody, AlertResolveResponse } from '@/lib/contracts/alerts';
import { prisma } from '@/lib/db';
import { sendEmail } from '@/lib/email/send';
import { alertResolvedEmail } from '@/lib/email/templates';
import { env } from '@/lib/env';
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
    const { workspaceId } = ctx;

    try {
      // Body parse FIRST — a missing/invalid JSON body or an
      // undisclosed field 400s BEFORE any DB read so the schema
      // validation sits ahead of the scope gate. The
      // AlertResolveBody schema enforces `.max(500)` on `note`,
      // mirroring the VARCHAR(500) DB cap so a malformed client that
      // bypasses zod hits an INSERT-level rejection, not a stored
      // multi-column note.
      //
      // `req.json()` throws on a malformed body — mirror the FP
      // route and 400 explicitly so a non-JSON POST lands as an
      // immediate rejection rather than silently dropping into the
      // empty-body branch.
      let bodyInput: unknown = {};
      try {
        bodyInput = await req.json();
      } catch {
        return NextResponse.json(
          { error: 'bad_request', message: 'invalid JSON' },
          { status: 400 },
        );
      }
      const parsedBody = AlertResolveBody.safeParse(bodyInput);
      if (!parsedBody.success) {
        return NextResponse.json(
          { error: 'bad_request', issues: parsedBody.error.flatten() },
          { status: 400 },
        );
      }
      // Server-side normalization — `.trim()` is already applied by
      // zod on the parsed value, but fall back to null on a blank
      // note so the `closingNote` column stores NULL (NOT an empty
      // string) and so the row stays easy to query.
      const trimmedNote = parsedBody.data.note?.trim() ?? '';
      const closingNoteValue = trimmedNote.length > 0 ? trimmedNote : null;

      // Scope check FIRST. Cross-team probing and missing rows resolve
      // to the same opaque 404 — no existence leak, no UPDATE.
      const existing = await prisma.alert.findFirst({
        where: { id, teamId: workspaceId },
        select: {
          id: true,
          status: true,
          statusChangedAt: true,
          acknowledgedAt: true,
          // Read falsePositiveReason so the response envelope can
          // re-stamp the column (always null after resolve — but a
          // row that flipped `false_positive → resolved` may carry a
          // stale stamp until the next transition clears it; resolving
          // a false-positive row is rare in practice but the read
          // keeps the envelope round-trip symmetric with reopen's).
          falsePositiveReason: true,
          // Read the close-stamp trio for the idempotent branch —
          // a re-resolve preserves `closedAt`/`closedBy` and only
          // updates `closingNote` when the body carries one.
          closedAt: true,
          closedBy: true,
          closingNote: true,
          // Read the reopen stamp trio for envelope round-trip — a
          // row that has been re-marked previously (resolved →
          // open) keeps the trio, and re-resolving must NOT clear
          // it without an explicit reopen write.
          reopenedAt: true,
          reopenedBy: true,
          reopenReason: true,
        },
      });
      if (!existing) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      if (existing.status === 'resolved') {
        // Re-resolve on an already-resolved row. The "no body — no
        // write" branch preserves the prior idempotent posture so a
        // stale click does NOT churn statusChangedAt / closedAt /
        // closedBy. The "with a note" branch fires a partial UPDATE
        // (`closingNote` + `statusChangedAt`) so an operator who
        // ships a closing note later doesn't lose the existing
        // close-stamp trio. `closedAt` / `closedBy` are NEVER
        // overwritten after the first transition — they encode
        // "who first resolved this row", and a re-resolve with a
        // note is "re-recording the resolution text", not
        // "re-stamping who closed it".
        if (closingNoteValue == null) {
          // Empty / blank body — preserve first-write idempotence.
          const parsed = AlertResolveResponse.parse({
            id: existing.id,
            status: existing.status,
            statusChangedAt: existing.statusChangedAt
              ? existing.statusChangedAt.toISOString()
              : null,
            acknowledgedAt: existing.acknowledgedAt ? existing.acknowledgedAt.toISOString() : null,
            closedAt: existing.closedAt ? existing.closedAt.toISOString() : null,
            closedBy: existing.closedBy ?? null,
            closingNote: existing.closingNote ?? null,
            // Reopen trio is null on a resolve write — the columns
            // ride the lifecycle inverse pair and only the /reopen
            // route tampers with them. Reading them off the row
            // here so the envelope round-trips whatever is on disk
            // (a row that flipped open → resolved → open past will
            // carry a non-null reopened trio that this re-resolve
            // must NOT clear).
            reopenedAt: existing.reopenedAt ? existing.reopenedAt.toISOString() : null,
            reopenedBy: existing.reopenedBy ?? null,
            reopenReason: existing.reopenReason ?? null,
          });
          return NextResponse.json(parsed);
        }

        // Re-resolve WITH a fresh non-empty note — partial update
        // only. Avoids overwriting the close-stamp trio (closedAt /
        // closedBy encode first-write identity). Post-write teamId
        // verify mirrors the FIRST-write branch below so a tampered
        // race can't strand a cross-team row.
        const updated = await prisma.alert.update({
          where: { id },
          data: {
            statusChangedAt: new Date(),
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
        if (updated.teamId !== workspaceId) {
          return NextResponse.json({ error: 'not_found' }, { status: 404 });
        }
        const parsed = AlertResolveResponse.parse({
          id: updated.id,
          status: updated.status,
          statusChangedAt: updated.statusChangedAt ? updated.statusChangedAt.toISOString() : null,
          acknowledgedAt: updated.acknowledgedAt ? updated.acknowledgedAt.toISOString() : null,
          closedAt: updated.closedAt ? updated.closedAt.toISOString() : null,
          closedBy: updated.closedBy ?? null,
          closingNote: updated.closingNote ?? null,
          reopenedAt: updated.reopenedAt ? updated.reopenedAt.toISOString() : null,
          reopenedBy: updated.reopenedBy ?? null,
          reopenReason: updated.reopenReason ?? null,
        });
        return NextResponse.json(parsed);
      }

      // FIRST-write transition from 'open' / 'in_progress' /
      // 'false_positive' → 'resolved'. Stamp all of statusChangedAt,
      // closedAt, closedBy, (optional) closingNote on the same write.
      // Scope-assert via findFirst above AND a post-write teamId verify
      // below — mirrors the sibling resolve / triage / owner / snooze
      // routes. The reopen trio is preserved from disk (NOT cleared)
      // since the resolve inverse-op doesn't reset it — a row that
      // flipped resolved → open past already carries a reopen
      // stamp that this re-resolve preserves verbatim.
      const now = new Date();
      const updated = await prisma.alert.update({
        where: { id },
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
      if (updated.teamId !== workspaceId) {
        // Defence-in-depth verification: a tampered race produced a
        // cross-team write. Treat as the opaque not_found so the
        // resolver mutex holds.
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      // ─── Owner + watchers dispatch hook ─────────────────────────
      // Fire one email per recipient (deduped) AFTER the write has
      // landed AND the teamId-verify has confirmed the row stayed
      // on this team's shard. Internal reads stay inside the
      // existing `try` so a Prisma miss lands on the 500 fallback
      // rather than leaking an unhandled rejection. The `sendEmail`
      // call is fire-and-forget (`void … .catch(() => undefined)`)
      // so a proxy-side rate-limit never aborts the persisted
      // response — mirrors /api/alerts/[id]/notes exactly.
      //
      // Wiring mirrors /api/alerts/[id]/notes exactly:
      //  - Scalar-FK posture (no Prisma `@relation`) — Alert.ownerId
      //    is `WorkspaceMember.id`, AlertNote.authorUserId is `User.id`.
      //  - `workspaceId === teamId AND status === 'active'` pivot on
      //    every WorkspaceMember lookup — defends against cross-team
      //    rows, soft-deletes, and the `WorkspaceMember.id` FK being
      //    detached from the user.
      //  - Self-resolve skip — if the caller IS the owner we never
      //    email them. Same shape as notes' self-note skip.
      //  - Watcher strip — if the resolver previously posted a
      //    handoff note on this alert they appear in the AlertNote
      //    distinct-author batch; strip their email so they don't
      //    email themselves.
      const dispatchRow = await prisma.alert.findFirst({
        where: { id, teamId: workspaceId },
        select: {
          id: true,
          ownerId: true,
          severity: true,
          finding: { select: { asset: { select: { host: true } } } },
        },
      });
      if (dispatchRow?.ownerId) {
        const [callerWorkspaceMember, ownerMember] = await Promise.all([
          prisma.workspaceMember.findFirst({
            where: { userId: ctx.user.id, workspaceId, status: 'active' },
            select: { id: true },
          }),
          prisma.workspaceMember.findFirst({
            where: { id: dispatchRow.ownerId, workspaceId, status: 'active' },
            select: { userId: true },
          }),
        ]);
        // Self-resolve (caller IS the owner) — skip the dispatch
        // entirely. Same posture as /api/alerts/[id]/notes:190-193.
        const isSelfResolve = callerWorkspaceMember?.id === dispatchRow.ownerId;
        if (!isSelfResolve && ownerMember?.userId) {
          const resolverUser = await prisma.user.findUnique({
            where: { id: ctx.user.id },
            select: { email: true },
          });
          const ownerUser = await prisma.user.findUnique({
            where: { id: ownerMember.userId },
            select: { email: true },
          });
          // Watcher batch — every distinct AlertNote author on this
          // thread. Scalar-FK posture matches
          // src/app/api/alerts/[id]/route.ts:127 ownerName read.
          const noteRows = await prisma.alertNote.findMany({
            where: { alertId: id },
            select: { authorUserId: true },
            distinct: ['authorUserId'],
          });
          const distinctWriterIds = Array.from(new Set(noteRows.map((r) => r.authorUserId)));
          const watcherUsers = distinctWriterIds.length
            ? await prisma.user.findMany({
                where: { id: { in: distinctWriterIds } },
                select: { id: true, email: true },
              })
            : [];
          const resolverEmail = resolverUser?.email ?? '';
          // Recipient filter — null/blank email dropped silently
          // (soft-deleted edge case). Resolver excluded so they
          // don't email themselves even if they previously posted
          // a handoff note on this thread.
          const emailKey = (e: string | null | undefined): string | null =>
            e && e.length > 0 && e !== resolverEmail ? e : null;
          const ownerRecipient = emailKey(ownerUser?.email);
          const watcherRecipients = watcherUsers
            .map((u) => emailKey(u.email))
            .filter((e): e is string => e !== null);
          const recipients = ownerRecipient
            ? Array.from(new Set([ownerRecipient, ...watcherRecipients]))
            : Array.from(new Set(watcherRecipients));
          if (recipients.length > 0) {
            const appBaseUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');
            const ctaUrl = `${appBaseUrl}/alerts/${id}`;
            const tmpl = alertResolvedEmail({
              host: dispatchRow.finding?.asset?.host ?? '',
              severity: dispatchRow.severity,
              closingNote: closingNoteValue,
              ctaUrl,
            });
            for (const to of recipients) {
              void sendEmail({ to, ...tmpl }).catch(() => undefined);
            }
          }
        }
      }

      const parsed = AlertResolveResponse.parse({
        id: updated.id,
        status: updated.status,
        statusChangedAt: updated.statusChangedAt ? updated.statusChangedAt.toISOString() : null,
        acknowledgedAt: updated.acknowledgedAt ? updated.acknowledgedAt.toISOString() : null,
        closedAt: updated.closedAt ? updated.closedAt.toISOString() : null,
        closedBy: updated.closedBy ?? null,
        closingNote: updated.closingNote ?? null,
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
