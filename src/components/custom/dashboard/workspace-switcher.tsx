// @polsia:user-owned — Client-side workspace selector for the member dashboard shell.
'use client';

import { ChevronsUpDown } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { apiFetch } from '@/lib/api-client';
import { ActiveWorkspaceResponse } from '@/lib/contracts/active-workspace';
import { WorkspaceList, type WorkspaceSummary } from '@/lib/contracts/workspaces';

export function WorkspaceSwitcher() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selectionError, setSelectionError] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);

  useEffect(() => {
    let mounted = true;
    apiFetch('/api/workspaces', { schema: WorkspaceList })
      .then((result) => {
        if (!mounted) return;
        setWorkspaces(result.workspaces);
        const activeId = result.activeWorkspaceId;
        setActiveWorkspaceId(
          activeId && result.workspaces.some((workspace) => workspace.id === activeId)
            ? activeId
            : null,
        );
      })
      .catch(() => {
        if (!mounted) return;
        setLoadError(true);
        setWorkspaces([]);
      });

    return () => {
      mounted = false;
    };
  }, []);

  async function selectWorkspace(workspaceId: string) {
    setSelectionError(false);
    setIsSwitching(true);
    try {
      const result = await apiFetch('/api/workspace/active', {
        method: 'POST',
        body: JSON.stringify({ workspaceId }),
        schema: ActiveWorkspaceResponse,
      });
      setActiveWorkspaceId(result.workspaceId);
      window.dispatchEvent(new Event('active-workspace-changed'));
      router.refresh();
    } catch {
      setSelectionError(true);
    } finally {
      setIsSwitching(false);
    }
  }

  if (workspaces === null) {
    return (
      <output className="rounded-md border border-border/70 px-3 py-2 text-xs text-muted-foreground">
        Loading workspace…
      </output>
    );
  }

  if (loadError) {
    return (
      <p
        className="rounded-md border border-border/70 px-3 py-2 text-xs text-muted-foreground"
        role="alert"
      >
        Workspaces are unavailable.
      </p>
    );
  }

  if (workspaces.length === 0) {
    return (
      <output className="rounded-md border border-border/70 px-3 py-2 text-xs text-muted-foreground">
        No workspaces available.
      </output>
    );
  }

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
  const displayedWorkspace =
    activeWorkspace ?? (workspaces.length === 1 ? workspaces[0] : undefined);
  const displayedName = displayedWorkspace?.name ?? 'Select workspace';
  const canSwitch = workspaces.length > 1 || displayedWorkspace?.id !== activeWorkspaceId;

  return (
    <div className="w-full min-w-0">
      {canSwitch ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={`Active workspace: ${displayedName}`}
              className="w-full min-w-0 justify-between"
              disabled={isSwitching}
              size="sm"
              variant="outline"
            >
              <span className="truncate">{displayedName}</span>
              <ChevronsUpDown
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-[var(--radix-dropdown-menu-trigger-width)]"
          >
            <DropdownMenuLabel>Switch workspace</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              onValueChange={(workspaceId) => void selectWorkspace(workspaceId)}
              value={activeWorkspaceId ?? ''}
            >
              {workspaces.map((workspace) => (
                <DropdownMenuRadioItem
                  disabled={isSwitching}
                  key={workspace.id}
                  value={workspace.id}
                >
                  <span className="truncate">{workspace.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <p className="flex min-h-8 items-center rounded-md border border-border/70 px-3 text-xs font-medium text-foreground">
          <span className="truncate">{displayedName}</span>
        </p>
      )}
      {selectionError ? (
        <p className="mt-1 text-xs text-destructive" role="alert">
          Could not switch workspace. Try again.
        </p>
      ) : null}
    </div>
  );
}
