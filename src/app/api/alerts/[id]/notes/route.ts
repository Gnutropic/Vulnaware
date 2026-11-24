// @polsia:user-owned — GET/POST /api/alerts/[id]/notes. Read AND write
// are gated to active team members; the composer in the bottom-of-page
// pane is intentionally NOT assignee-only — SOC teams drop shift handoff
// context here freely. Mirrors the [id]/comments posture on the cross-
// team / not-found gate: opaque 404 on miss so a non-member cannot probe
// for row existence via the membership 403 vs the not-found 404.
//
// `authorEmail` resolution matches the `ownerName` flow on /api/alerts/
// [id]/route.ts: scalar FK to User.id, no Prisma relation, defers to
// `User.findMany({ where: { id: { in: authorUserIds } } })` for batch
// resolution. Email is preferred over name on this surface because the
// pane labels shift-handoff readers at a glance and the email is the
// unambiguous identity (names collide more freely). Names are best-
// effort (`null` when the User row is gone).

import 'server-only';
import { NextResponse } from 'next/server';
import { requireAlertWorkspaceMember } from '@/lib/business/alert-workspace-access';
import { AlertNoteCreateBody, AlertNoteItem, AlertNoteList } from '@/lib/contracts/alert-notes';
import { prisma } from '@/lib/db';
import { sendEmail } from '@/lib/email/send';
import { alertNoteEmail } from '@/lib/email/templates';
import { env } from '@/lib/env';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
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
      // Cross-team / not-found gate FIRST so a non-member can't probe
      // for row existence via membership 403 vs the not-found 404.
      const existing = await prisma.alert.findFirst({
        where: { id, teamId },
        select: { id: true },
      });
      if (!existing) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      // Reverse-chronological fetch — newest note first so the
      // bottom-of-page pane can render the array as-is. The composite
      // index `@@index([alertId, createdAt])` covers the lookup.
      const rows = await prisma.alertNote.findMany({
        where: { alertId: id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          alertId: true,
          authorUserId: true,
          body: true,
          createdAt: true,
        },
      });

      // Batched `User` lookup for `authorEmail` — scalar FK posture, same
      // resolution shape as /api/alerts/[id] owner-name link. Emails
      // are best-effort (`null` when the User row is gone — soft-delete
      // edge case; the UI de-renders to "unknown" via the typed
      // contract).
      const authorIds = Array.from(new Set(rows.map((r) => r.authorUserId)));
      const users = authorIds.length
        ? await prisma.user.findMany({
            where: { id: { in: authorIds } },
            select: { id: true, email: true },
          })
        : [];
      const emailById = new Map(users.map((u) => [u.id, u.email ?? null] as const));

      const items = AlertNoteList.parse({
        items: rows.map((r) =>
          AlertNoteItem.parse({
            id: r.id,
            alertId: r.alertId,
            authorUserId: r.authorUserId,
            authorEmail: emailById.get(r.authorUserId) ?? null,
            body: r.body,
            createdAt: r.createdAt.toISOString(),
          }),
        ),
      });
      return NextResponse.json(items);
    } catch {
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  });
}

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

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { errors: { _: 'Request body must be valid JSON.' } },
        { status: 400 },
      );
    }

    const parsed = AlertNoteCreateBody.safeParse(raw);
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      const errors: Record<string, string> = {};
      for (const [field, messages] of Object.entries(fieldErrors)) {
        const first = messages?.[0];
        if (first) errors[field] = first;
      }
      if (Object.keys(errors).length === 0) errors._ = 'Invalid request body.';
      return NextResponse.json({ errors }, { status: 400 });
    }

    const { body } = parsed.data;

    try {
      // Cross-team / not-found gate FIRST so a non-member can't probe
      // for row existence via membership 403 vs the not-found 404.
      const existing = await prisma.alert.findFirst({
        where: { id, teamId },
        select: { id: true },
      });
      if (!existing) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      const created = await prisma.alertNote.create({
        data: { alertId: id, authorUserId: ctx.user.id, body },
        select: {
          id: true,
          alertId: true,
          authorUserId: true,
          body: true,
          createdAt: true,
        },
      });

      const author = await prisma.user.findUnique({
        where: { id: created.authorUserId },
        select: { email: true },
      });

      // ─── Owner dispatch hook ─────────────────────────────────────
      // Fire one transactional email to the alert owner's User.email
      // when a teammate (NOT the owner) posts an AlertNote on an
      // owned alert. Internal reads stay inside the existing `try`
      // so a Prisma miss lands on the 500 fallback rather than
      // leaking an unhandled rejection. The `sendEmail` call is
      // fire-and-forget (`void … .catch(() => undefined)`) so a
      // proxy-side rate-limit never aborts the persisted response.
      //
      // Cross-team safety: every WorkspaceMember lookup
      // re-validates `workspaceId === teamId AND status === 'active'`
      // — mirror of src/app/api/alerts/[id]/route.ts:103-114.
      const parentAlert = await prisma.alert.findFirst({
        where: { id, teamId },
        select: {
          ownerId: true,
          finding: { select: { cveId: true } },
        },
      });
      if (parentAlert?.ownerId) {
        // Resolve caller's WorkspaceMember.id on this team so the
        // self-note check is a cheap userId-equality compare
        // against the `Alert.ownerId` (`WorkspaceMember.id`,
        // NOT `Membership.id`) FK posture — exact mirror of the
        // `me.isAssignee` resolution at src/app/api/alerts/[id]/
        // route.ts:123-126.
        const callerWorkspaceMember = await prisma.workspaceMember.findFirst({
          where: { userId: ctx.user.id, workspaceId: teamId, status: 'active' },
          select: { id: true },
        });
        // Skip self-notes — the author IS the owner.
        if (callerWorkspaceMember?.id !== parentAlert.ownerId) {
          // Pivot WorkspaceMember → User.email via the FK. If
          // either lookup misses the row has drifted (status
          // flipped, user deleted, cross-team row) and we
          // silently skip the send.
          const ownerMember = await prisma.workspaceMember.findFirst({
            where: { id: parentAlert.ownerId, workspaceId: teamId, status: 'active' },
            select: { userId: true },
          });
          if (ownerMember?.userId) {
            const ownerUser = await prisma.user.findUnique({
              where: { id: ownerMember.userId },
              select: { email: true },
            });
            if (ownerUser?.email) {
              const appBaseUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');
              const ctaUrl = `${appBaseUrl}/alerts/${id}#notes`;
              void sendEmail({
                to: ownerUser.email,
                ...alertNoteEmail({
                  findingTitle: parentAlert.finding?.cveId ?? '',
                  noteBody: created.body,
                  authorEmail: author?.email ?? '',
                  ctaUrl,
                }),
              }).catch(() => undefined);
            }
          }
        }
      }

      const item = AlertNoteItem.parse({
        id: created.id,
        alertId: created.alertId,
        authorUserId: created.authorUserId,
        authorEmail: author?.email ?? null,
        body: created.body,
        createdAt: created.createdAt.toISOString(),
      });
      return NextResponse.json(item, { status: 201 });
    } catch {
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  });
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'GET, POST' } },
  );
}

export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
