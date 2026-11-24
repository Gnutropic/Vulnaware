// @polsia:user-owned — admin-gated read endpoint for the per-team
// weekly risk-trend email digest log. Mirrors
// src/app/api/alerts/trend/route.ts shape (same imports + auth gating +
// `methodNotAllowed` stub for non-GET verbs).
//
// Access-control posture:
//   - GET requires `requireTeamRole('admin')` — viewers / members get
//     403, unauthenticated callers get 401.
//   - Every read query carries `workspaceId: ctx.membership.teamId` so
//     cross-team leakage is impossible regardless of URL tampering.
//   - Returns the 10 most-recent DigestLog rows for the caller's team
//     (newest first by `createdAt`). Newer rows carry the JSON summary
//     + subject so the admin UI can render them without a second
//     round-trip.
//
// Wire surface: `{ items: WeeklyDigestLogRow[] }` — the admin island's
// `admin-digest-trigger.tsx` parses the response through `WeeklyDigestLogList`.

import 'server-only';
import { NextResponse } from 'next/server';
import { WeeklyDigestLogList, WeeklyDigestLogRow } from '@/lib/contracts/digest';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { requireTeamRole } from '@/lib/team-auth';

export const dynamic = 'force-dynamic';

const ROW_LIMIT = 10;

export async function GET(req: Request) {
  return withApiRequest(req, async () => {
    let ctx: Awaited<ReturnType<typeof requireTeamRole>>;
    try {
      ctx = await requireTeamRole('admin');
    } catch (res) {
      return res as Response;
    }

    setRequestAuth({ userId: ctx.user.id, teamId: ctx.membership.teamId });

    try {
      const rows = await prisma.digestLog.findMany({
        where: { workspaceId: ctx.membership.teamId },
        orderBy: { createdAt: 'desc' },
        take: ROW_LIMIT,
        select: {
          id: true,
          weekStart: true,
          status: true,
          triggeredBy: true,
          summarySubject: true,
          recipientCount: true,
          createdAt: true,
        },
      });

      const items = rows.map((row) =>
        WeeklyDigestLogRow.parse({
          id: row.id,
          weekStart: row.weekStart.toISOString(),
          status: row.status,
          triggeredBy: row.triggeredBy,
          summarySubject: row.summarySubject,
          recipientCount: row.recipientCount,
          createdAt: row.createdAt.toISOString(),
        }),
      );
      return NextResponse.json(WeeklyDigestLogList.parse({ items }), { status: 200 });
    } catch {
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  });
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'GET' } },
  );
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
