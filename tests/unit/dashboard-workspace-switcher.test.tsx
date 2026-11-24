// @vitest-environment jsdom
// @polsia:user-owned — Loading, visibility, selection and failure coverage.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveWorkspaceResponse } from '@/lib/contracts/active-workspace';
import type { WorkspaceList } from '@/lib/contracts/workspaces';

const { apiFetchMock, refreshMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  refreshMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshMock }) }));
vi.mock('@/lib/api-client', () => ({ apiFetch: apiFetchMock }));

import { WorkspaceSwitcher } from '@/components/custom/dashboard/workspace-switcher';

const workspaceList: WorkspaceList = {
  workspaces: [
    { id: 'workspace-1', name: 'Workspace One' },
    { id: 'workspace-2', name: 'Workspace Two' },
  ],
  activeWorkspaceId: 'workspace-1',
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mountSwitcher() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<WorkspaceSwitcher />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

async function click(element: Element | null) {
  await act(async () => {
    element?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function cleanup() {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await cleanup();
});

describe('WorkspaceSwitcher', () => {
  it('loads only the workspaces returned by the API and marks the active one', async () => {
    let resolveList: ((value: WorkspaceList) => void) | undefined;
    apiFetchMock.mockReturnValueOnce(
      new Promise<WorkspaceList>((resolve) => {
        resolveList = resolve;
      }),
    );

    const host = await mountSwitcher();
    expect(host.querySelector('output')?.textContent).toContain('Loading workspace');

    await act(async () => {
      resolveList?.(workspaceList);
    });
    expect(host.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Active workspace: Workspace One',
    );

    await click(host.querySelector('button'));
    const menuItems = [...document.body.querySelectorAll('[role="menuitemradio"]')];
    expect(menuItems.map((item) => item.textContent?.trim())).toEqual([
      'Workspace One',
      'Workspace Two',
    ]);
    expect(menuItems[0]?.getAttribute('aria-checked')).toBe('true');
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/workspaces',
      expect.objectContaining({ schema: expect.any(Object) }),
    );
  });

  it('persists a successful selection and refreshes the current route', async () => {
    apiFetchMock.mockResolvedValueOnce(workspaceList).mockResolvedValueOnce({
      workspaceId: 'workspace-2',
    });

    const host = await mountSwitcher();
    await click(host.querySelector('button'));
    await click([...document.body.querySelectorAll('[role="menuitemradio"]')][1] ?? null);

    expect(apiFetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/workspace/active',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ workspaceId: 'workspace-2' }),
        schema: ActiveWorkspaceResponse,
      }),
    );
    expect(host.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Active workspace: Workspace Two',
    );
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the selected workspace and announces a failed selection', async () => {
    apiFetchMock.mockResolvedValueOnce(workspaceList).mockRejectedValueOnce(new Error('Forbidden'));

    const host = await mountSwitcher();
    await click(host.querySelector('button'));
    await click([...document.body.querySelectorAll('[role="menuitemradio"]')][1] ?? null);

    expect(host.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Active workspace: Workspace One',
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not switch workspace',
    );
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('shows a sole active workspace without a needless switch menu', async () => {
    apiFetchMock.mockResolvedValueOnce({
      workspaces: [{ id: 'workspace-1', name: 'Only workspace' }],
      activeWorkspaceId: 'workspace-1',
    });

    const host = await mountSwitcher();

    expect(host.textContent).toContain('Only workspace');
    expect(host.querySelector('button')).toBeNull();
  });

  it('shows concise empty and unavailable states', async () => {
    apiFetchMock.mockResolvedValueOnce({ workspaces: [], activeWorkspaceId: null });
    const emptyHost = await mountSwitcher();
    expect(emptyHost.querySelector('output')?.textContent).toContain('No workspaces available');
    await cleanup();

    apiFetchMock.mockRejectedValueOnce(new Error('Unable to load workspaces'));
    const failedHost = await mountSwitcher();
    expect(failedHost.querySelector('[role="alert"]')?.textContent).toContain(
      'Workspaces are unavailable',
    );
  });
});
