// @polsia:user-owned — GET/POST /api/alerts/[id]/comments. Read is gated
// to active team members; write is further restricted to the assignee.
// Mirrors the [id]/owner + [id]/snooze posture: opaque 404 on miss or
// cross-team id so a caller cannot probe for row existence. POST 403
// is typed (`{ error: 'not_assignee' }`) — the caller flows the message
// to a toast; the UI never sees a wrong shape on the wire.
//
// `authorName` resolution matches the `ownerName` flow on /api/alerts/
// [id]/route.ts: scalar FK to User.id, no Prisma relation, defers to
// `User.findMany({ where: { id: { in: authorIds } } })` for batch
// resolution. Names are best-effort (`null` when the User row is gone).
//
// Assignee check: `Alert.ownerId` holds `WorkspaceMember.id` (the picker
// writes that), NOT `Membership.id`. The handler resolves the caller's
// own `WorkspaceMember.id` on the team so the comparison is type-aligned
// with the FK column.

import 'server-only';
import { NextResponse } from 'next/server';
import { requireAlertWorkspaceMember } from '@/lib/business/alert-workspace-access';
import {
  AlertCommentCreateBody,
  AlertCommentItem,
  AlertCommentList,
} from '@/lib/contracts/alert-comments';
import { prisma } from '@/lib/db';
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
      const existing = await prisma.alert.findFirst({
        where: { id, teamId },
        select: { id: true, ownerId: true },
      });
      if (!existing) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      // Visibility scope: the read is widened to "alert's owner or
      // anyone who has posted on this alert". The assignee sees the
      // whole thread; a team member who has ever commented also sees
      // the whole thread (read-back of their own row plus co-conversation);
      // everyone else is narrowed to rows they themselves posted.
      // Resolved in app code via `Alert.ownerId` (the WorkspaceMember FK)
      // compared against the caller's own active WorkspaceMember row on
      // the team.
      const callerWorkspaceMember = await prisma.workspaceMember.findFirst({
        where: { userId: ctx.user.id, workspaceId: teamId, status: 'active' },
        select: { id: true },
      });
      const callerIsAssignee =
        existing.ownerId != null &&
        callerWorkspaceMember != null &&
        existing.ownerId === callerWorkspaceMember.id;
      // Index-only probe — `select: { id: true }` keeps the read off the
      // body column. The composite `@@index([alertId, createdAt])` covers
      // the lookup; the `authorId` filter narrows further within that
      // range. Skip when caller is already known to be the assignee.
      const callerHasCommented = callerIsAssignee
        ? false
        : (await prisma.alertComment.findFirst({
            where: { alertId: id, authorId: ctx.user.id },
            select: { id: true },
          })) != null;
      const fullThread = callerIsAssignee || callerHasCommented;
      const where = {
        alertId: id,
        // Assignee-or-commenters see the whole thread; the rest of the
        // team is still narrowed to their own posts. This is the
        // visible-rows projection on the server — the client island
        // never has to render a "row I can't see" shell.
        ...(fullThread ? {} : { authorId: ctx.user.id }),
      };

      const rows = await prisma.alertComment.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        select: { id: true, alertId: true, authorId: true, body: true, createdAt: true },
      });

      // Batched `User` lookup for `authorName` — scalar FK posture, same
      // resolution shape as /api/alerts/[id] owner-name link. Names are
      // best-effort (`null` when the User row is gone — soft-delete edge
      // case; the UI de-renders to "Unknown" via the typed contract).
      const authorIds = Array.from(new Set(rows.map((r) => r.authorId)));
      const users = authorIds.length
        ? await prisma.user.findMany({
            where: { id: { in: authorIds } },
            select: { id: true, name: true },
          })
        : [];
      const nameById = new Map(users.map((u) => [u.id, u.name ?? null] as const));

      const items = AlertCommentList.parse({
        items: rows.map((r) =>
          AlertCommentItem.parse({
            id: r.id,
            alertId: r.alertId,
            authorId: r.authorId,
            authorName: nameById.get(r.authorId) ?? null,
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

    const parsed = AlertCommentCreateBody.safeParse(raw);
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
      const alert = await prisma.alert.findFirst({
        where: { id, teamId },
        select: { id: true, ownerId: true },
      });
      // Cross-team / not-found gate FIRST so a non-assignee can't probe
      // for row existence via the assignee 403 vs the not-found 404.
      if (!alert) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      // Assignee gate — the brief narrows writers to the alert's
      // assignee. `Alert.ownerId` is a scalar FK on `WorkspaceMember.id`,
      // so we resolve the caller's OWN `WorkspaceMember.id` (not
      // `Membership.id`) and compare on type-aligned ids.
      const callerWorkspaceMember = await prisma.workspaceMember.findFirst({
        where: { userId: ctx.user.id, workspaceId: teamId, status: 'active' },
        select: { id: true },
      });
      const isAssignee =
        alert.ownerId !== null &&
        callerWorkspaceMember !== null &&
        alert.ownerId === callerWorkspaceMember.id;
      if (!isAssignee) {
        return NextResponse.json({ error: 'not_assignee' }, { status: 403 });
      }

      const created = await prisma.alertComment.create({
        data: { alertId: id, authorId: ctx.user.id, body },
        select: { id: true, alertId: true, authorId: true, body: true, createdAt: true },
      });

      const author = await prisma.user.findUnique({
        where: { id: created.authorId },
        select: { name: true },
      });
      const item = AlertCommentItem.parse({
        id: created.id,
        alertId: created.alertId,
        authorId: created.authorId,
        authorName: author?.name ?? null,
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
