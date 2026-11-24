// @polsia:user-owned — Shared client/server contract for accessible workspaces.
import { z } from 'zod';

export const WorkspaceSummary = z.object({
  id: z.string().min(1),
  name: z.string(),
});

export const WorkspaceList = z.object({
  workspaces: z.array(WorkspaceSummary),
  activeWorkspaceId: z.string().min(1).nullable(),
});

export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;
export type WorkspaceList = z.infer<typeof WorkspaceList>;
