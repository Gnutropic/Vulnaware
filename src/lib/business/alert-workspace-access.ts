// @polsia:user-owned — Active-workspace authorization for alert detail APIs.
import 'server-only';
import { resolveDashboardWorkspaceContext } from '@/lib/business/dashboard-workspace-context';
import { prisma } from '@/lib/db';
import { hasAtLeast } from '@/lib/permissions/roles';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export interface AlertWorkspaceAccessContext {
  user: SessionUser;
  workspaceId: string;
  workspaceMemberId: string;
}

/**
 * Requires a signed-in user with an active member-level roster row in the
 * currently selected workspace. The better-auth admin role is intentionally
 * not part of this decision.
 */
export async function requireAlertWorkspaceMember(
  req?: Request,
): Promise<AlertWorkspaceAccessContext> {
  const user = await requireAuth(req);
  const context = await resolveDashboardWorkspaceContext(user.id);
  const workspaceMember = context?.workspaceMemberId
    ? await prisma.workspaceMember.findFirst({
        where: {
          id: context.workspaceMemberId,
          userId: user.id,
          workspaceId: context.workspaceId,
          status: 'active',
        },
        select: { role: true },
      })
    : null;

  if (
    !context?.workspaceMemberId ||
    !workspaceMember ||
    !hasAtLeast(workspaceMember.role, 'member')
  ) {
    throw Response.json({ error: 'not_found' }, { status: 404 });
  }

  return {
    user,
    workspaceId: context.workspaceId,
    workspaceMemberId: context.workspaceMemberId,
  };
}
