// @polsia:user-owned — Workspace-scoped status mutation for alert details.

import 'server-only';
import { NextResponse } from 'next/server';
import { requireAlertWorkspaceMember } from '@/lib/business/alert-workspace-access';
import { AlertStatusMutationBody, AlertStatusMutationResponse } from '@/lib/contracts/alerts';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const statusSelect = {
  id: true,
  status: true,
  statusChangedAt: true,
  acknowledgedAt: true,
  snoozedUntil: true,
  falsePositiveReason: true,
  closedAt: true,
  closedBy: true,
  closingNote: true,
  reopenedAt: true,
  reopenedBy: true,
  reopenReason: true,
} as const;

function toResponse(row: {
  id: string;
  status: string;
  statusChangedAt: Date | null;
  acknowledgedAt: Date | null;
  snoozedUntil: Date | null;
  falsePositiveReason: string | null;
  closedAt: Date | null;
  closedBy: string | null;
  closingNote: string | null;
  reopenedAt: Date | null;
  reopenedBy: string | null;
  reopenReason: string | null;
}) {
  return AlertStatusMutationResponse.parse({
    id: row.id,
    status: row.status,
    statusChangedAt: row.statusChangedAt?.toISOString() ?? null,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    snoozedUntil: row.snoozedUntil?.toISOString() ?? null,
    falsePositiveReason: row.falsePositiveReason,
    closedAt: row.closedAt?.toISOString() ?? null,
    closedBy: row.closedBy,
    closingNote: row.closingNote,
    reopenedAt: row.reopenedAt?.toISOString() ?? null,
    reopenedBy: row.reopenedBy,
    reopenReason: row.reopenReason,
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiRequest(request, async () => {
    if (!sameOrigin(request)) {
      return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
    }

    let ctx: Awaited<ReturnType<typeof requireAlertWorkspaceMember>>;
    try {
      ctx = await requireAlertWorkspaceMember(request);
    } catch (response) {
      return response as Response;
    }

    setRequestAuth({ userId: ctx.user.id, teamId: ctx.workspaceId });

    let input: unknown;
    try {
      input = await request.json();
    } catch {
      return NextResponse.json({ error: 'bad_request', message: 'invalid JSON' }, { status: 400 });
    }

    const parsed = AlertStatusMutationBody.safeParse(input);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'bad_request', issues: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { id } = await params;
    const { workspaceId, user } = ctx;

    try {
      const existing = await prisma.alert.findFirst({
        where: { id, teamId: workspaceId },
        select: statusSelect,
      });

      // Missing and other-workspace ids share the same opaque response.
      if (!existing) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      if (existing.status === parsed.data.status) {
        return NextResponse.json(toResponse(existing));
      }

      const changedAt = new Date();
      const data =
        parsed.data.status === 'false_positive'
          ? {
              status: parsed.data.status,
              statusChangedAt: changedAt,
              falsePositiveReason: parsed.data.reason,
            }
          : parsed.data.status === 'resolved'
            ? {
                status: parsed.data.status,
                statusChangedAt: changedAt,
                closedAt: changedAt,
                closedBy: user.id,
                closingNote: parsed.data.note?.trim() || null,
              }
            : parsed.data.status === 'open'
              ? {
                  status: parsed.data.status,
                  statusChangedAt: changedAt,
                  falsePositiveReason: null,
                  closedAt: null,
                  closedBy: null,
                  closingNote: null,
                  reopenedAt: changedAt,
                  reopenedBy: user.id,
                  reopenReason: null,
                }
              : { status: parsed.data.status, statusChangedAt: changedAt };

      // The compare-and-update is scoped by both the id and active
      // workspace, and by the status observed above so concurrent changes
      // cannot overwrite a newer transition.
      const result = await prisma.alert.updateMany({
        where: { id, teamId: workspaceId, status: existing.status },
        data,
      });

      const saved = await prisma.alert.findFirst({
        where: { id, teamId: workspaceId },
        select: statusSelect,
      });
      if (!saved) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }
      if (result.count === 0 && saved.status !== parsed.data.status) {
        return NextResponse.json(
          {
            error: 'status_conflict',
            message: 'This alert changed elsewhere. Refresh and try again.',
          },
          { status: 409 },
        );
      }

      return NextResponse.json(toResponse(saved));
    } catch {
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  });
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { error: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'POST' } },
  );
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
