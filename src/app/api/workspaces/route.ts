// @polsia:user-owned — Authenticated list of workspaces available to the caller.
import 'server-only';
import { NextResponse } from 'next/server';
import { resolveActiveWorkspaceId } from '@/lib/business/active-workspace';
import { WorkspaceList } from '@/lib/contracts/workspaces';
import { prisma } from '@/lib/db';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch (response) {
    return response as Response;
  }

  try {
    const [activeMemberships, resolvedActiveWorkspaceId] = await Promise.all([
      prisma.workspaceMember.findMany({
        where: { userId: user.id, status: 'active' },
        select: { workspaceId: true },
      }),
      resolveActiveWorkspaceId(user.id),
    ]);
    const memberWorkspaceIds = [...new Set(activeMemberships.map((member) => member.workspaceId))];
    const workspaces = await prisma.workspace.findMany({
      where: {
        OR: [{ ownerUserId: user.id }, { id: { in: memberWorkspaceIds } }],
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true },
    });
    const activeWorkspaceId = workspaces.some(
      (workspace) => workspace.id === resolvedActiveWorkspaceId,
    )
      ? resolvedActiveWorkspaceId
      : null;

    return NextResponse.json(WorkspaceList.parse({ workspaces, activeWorkspaceId }));
  } catch {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
