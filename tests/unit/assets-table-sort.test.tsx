// @vitest-environment jsdom

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { AssetsTable } from '@/components/dashboard/assets-table';
import type { AssetSortKey } from '@/lib/contracts/assets';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(
  sort: AssetSortKey,
  onSortChange: (sort: AssetSortKey) => void,
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<AssetsTable items={[]} sort={sort} onSortChange={onSortChange} />);
  });
  return container;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

describe('assets unresolved-count sort control', () => {
  it('shows the active direction and toggles descending to ascending', async () => {
    const onSortChange = vi.fn<(sort: AssetSortKey) => void>();
    const host = await render('unresolvedCount', onSortChange);
    const activeControls = host.querySelectorAll(
      'button[aria-label="Sort by unresolved alerts. Current order: descending. Activate to sort ascending."]',
    );

    expect(activeControls.length).toBeGreaterThan(0);
    expect(host.querySelector('th[aria-sort="descending"]')?.textContent).toContain(
      'Unresolved alerts',
    );
    expect(activeControls[0]?.textContent).toContain('↓');
    await act(async () => {
      activeControls[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSortChange).toHaveBeenCalledWith('unresolvedCount:asc');
  });

  it('shows the ascending direction and toggles back to descending', async () => {
    const onSortChange = vi.fn<(sort: AssetSortKey) => void>();
    const host = await render('unresolvedCount:asc', onSortChange);
    const activeControls = host.querySelectorAll(
      'button[aria-label="Sort by unresolved alerts. Current order: ascending. Activate to sort descending."]',
    );

    expect(activeControls.length).toBeGreaterThan(0);
    expect(host.querySelector('th[aria-sort="ascending"]')?.textContent).toContain(
      'Unresolved alerts',
    );
    expect(activeControls[0]?.textContent).toContain('↑');
    await act(async () => {
      activeControls[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSortChange).toHaveBeenCalledWith('unresolvedCount');
  });
});

describe('assets latest-scan sort control', () => {
  it('shows newest first and toggles to oldest first', async () => {
    const onSortChange = vi.fn<(sort: AssetSortKey) => void>();
    const host = await render('latestScanAt', onSortChange);
    const activeControls = host.querySelectorAll(
      'button[aria-label="Sort by latest scan date. Current order: newest first. Activate to sort oldest first."]',
    );

    expect(activeControls.length).toBeGreaterThan(0);
    expect(host.querySelector('th[aria-sort="descending"]')?.textContent).toContain('Latest scan');
    expect(activeControls[0]?.textContent).toContain('↓');
    await act(async () => {
      activeControls[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSortChange).toHaveBeenCalledWith('latestScanAt:asc');
  });

  it('shows oldest first and toggles back to newest first', async () => {
    const onSortChange = vi.fn<(sort: AssetSortKey) => void>();
    const host = await render('latestScanAt:asc', onSortChange);
    const activeControls = host.querySelectorAll(
      'button[aria-label="Sort by latest scan date. Current order: oldest first. Activate to sort newest first."]',
    );

    expect(activeControls.length).toBeGreaterThan(0);
    expect(host.querySelector('th[aria-sort="ascending"]')?.textContent).toContain('Latest scan');
    expect(activeControls[0]?.textContent).toContain('↑');
    await act(async () => {
      activeControls[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSortChange).toHaveBeenCalledWith('latestScanAt');
  });
});
