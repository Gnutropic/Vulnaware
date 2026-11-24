// @polsia:user-owned — Shared request and response shapes for active workspace selection.
// Keep this module client-safe: it contains only Zod contracts.
import { z } from 'zod';

export const ActiveWorkspaceId = z.string().trim().min(1).max(191);

export const ActiveWorkspaceSelectionRequest = z
  .object({ workspaceId: ActiveWorkspaceId })
  .strict();

export const ActiveWorkspaceResponse = z.object({
  workspaceId: ActiveWorkspaceId,
});

export type ActiveWorkspaceSelectionRequest = z.infer<typeof ActiveWorkspaceSelectionRequest>;
export type ActiveWorkspaceResponse = z.infer<typeof ActiveWorkspaceResponse>;
