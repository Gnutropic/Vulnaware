// @polsia:user-owned — Minimal workspace roster used by the alert detail
// page's owner picker. Distinct from /api/team/memberships (which renders
// the full settings/team page including pending invites, role metadata,
// join timestamps, etc.) — the picker only needs id + display label + email.
//
// `requireTeamRole('member')`: any team member can list colleagues. Pending
// invites are excluded because the alert owner FK must be an active
// member; surfacing them would just produce a 400 on submit.
//
// User join: `WorkspaceMember.userId` is the scalar FK into the locked
// `User` model (no Prisma relation edge). We batch-resolve User rows by
// `in: userIds` so even a multi-dozen roster renders in two round trips
// instead of N. `name` falls back to email when `User.name` is null so
// the picker always has a renderable label.

import 'server-only';
import { NextResponse } from 'next/server';
import { MemberOption, MemberOptionList } from '@/lib/contracts/team';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { requireTeamRole } from '@/lib/team-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
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
      const rows = await prisma.workspaceMember.findMany({
        where: { workspaceId: teamId, status: 'active' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, userId: true, email: true },
      });

      const userIds = Array.from(
        new Set(
          rows
            .map((r) => r.userId)
            .filter((v): v is string => typeof v === 'string' && v.length > 0),
        ),
      );
      const users = userIds.length
        ? await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, email: true, name: true },
          })
        : [];
      const userById = new Map(users.map((u) => [u.id, u]));

      const items = rows.map((row) => {
        const u = userById.get(row.userId ?? '');
        return MemberOption.parse({
          id: row.id,
          // Picker label: prefer the better-auth User.name, else fall back
          // to the WorkspaceMember.email (the auth bootstrap often lands
          // the row before the User row syncs a name in).
          name: u?.name ?? row.email,
          email: u?.email ?? row.email,
        });
      });

      return NextResponse.json(MemberOptionList.parse({ items }));
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
