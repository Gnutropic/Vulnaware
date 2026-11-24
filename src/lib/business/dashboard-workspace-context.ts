// @polsia:user-owned — Resolves dashboard reads against the caller's active workspace.
import 'server-only';
import { resolveActiveWorkspaceId } from '@/lib/business/active-workspace';
import { prisma } from '@/lib/db';

export interface DashboardWorkspaceContext {
  workspaceId: string;
  workspaceMemberId: string | null;
}

/**
 * Resolves the cookie-selected workspace through the shared ownership and active
 * membership checks, then returns the caller's active roster row for that scope.
 */
export async function resolveDashboardWorkspaceContext(
  userId: string,
): Promise<DashboardWorkspaceContext | null> {
  const workspaceId = await resolveActiveWorkspaceId(userId);
  if (!workspaceId) return null;

  const workspaceMember = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId, status: 'active' },
    select: { id: true },
  });

  return { workspaceId, workspaceMemberId: workspaceMember?.id ?? null };
}
