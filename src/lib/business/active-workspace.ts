// @polsia:user-owned — Server-side active workspace selection and access validation.
import 'server-only';
import type { Prisma } from '@prisma/client';
import { cookies } from 'next/headers';
import { ActiveWorkspaceId } from '@/lib/contracts/active-workspace';
import { prisma } from '@/lib/db';

export const ACTIVE_WORKSPACE_COOKIE = 'polsia_active_workspace';
export const ACTIVE_WORKSPACE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export type WorkspaceContextClient = Pick<
  Prisma.TransactionClient,
  'workspace' | 'workspaceMember'
>;

/**
 * Returns whether a workspace exists and is owned by the user or has an active roster row.
 * Invited roster rows do not grant access.
 */
export async function canAccessWorkspace(
  userId: string,
  workspaceId: string,
  client: WorkspaceContextClient = prisma,
): Promise<boolean> {
  const ownedWorkspace = await client.workspace.findFirst({
    where: { id: workspaceId, ownerUserId: userId },
    select: { id: true },
  });
  if (ownedWorkspace) return true;

  // WorkspaceMember.workspaceId is a scalar reference, so verify the root exists
  // before trusting a roster row that could be orphaned.
  const workspace = await client.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true },
  });
  if (!workspace) return false;

  const activeMembership = await client.workspaceMember.findFirst({
    where: { workspaceId, userId, status: 'active' },
    select: { id: true },
  });
  return activeMembership !== null;
}

/**
 * Resolves a requested cookie value and otherwise selects the user's oldest owned
 * workspace. The ID tie-breaker keeps fallback selection deterministic.
 */
export async function resolveActiveWorkspaceIdForSelection(
  userId: string,
  cookieValue: string | null | undefined,
  client: WorkspaceContextClient = prisma,
): Promise<string | null> {
  const selectedId = ActiveWorkspaceId.safeParse(cookieValue);
  if (selectedId.success) {
    const workspaceId = selectedId.data;
    if (await canAccessWorkspace(userId, workspaceId, client)) return workspaceId;
  }

  const ownedWorkspace = await client.workspace.findFirst({
    where: { ownerUserId: userId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  return ownedWorkspace?.id ?? null;
}

/**
 * Shared route-handler entry point. Call after `requireAuth()` and pass the
 * returned user ID; never trust a workspace ID from a request without resolving it.
 */
export async function resolveActiveWorkspaceId(userId: string): Promise<string | null> {
  const cookieValue = (await cookies()).get(ACTIVE_WORKSPACE_COOKIE)?.value;
  return resolveActiveWorkspaceIdForSelection(userId, cookieValue);
}
