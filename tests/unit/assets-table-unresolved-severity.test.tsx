// @vitest-environment jsdom

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetsTable } from '@/components/dashboard/assets-table';
import type { AssetRollupRow } from '@/lib/contracts/assets';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function makeAsset(name: string, highestUnresolvedSeverity: AssetRollupRow['highestUnresolvedSeverity'],
  unresolvedCount: number, criticalCount: number): AssetRollupRow {
  return {
    name,
    assetType: 'web',
    scanCount30d: 0,
    openCount: 0,
    unresolvedCount,
    highestUnresolvedSeverity,
    criticalCount,
    riskScore: null,
    riskScoreChange: null,
    lastActivityAt: null,
    latestScanAt: null,
    latestScanStatus: null,
  };
}

async function render(items: AssetRollupRow[]) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<AssetsTable items={items} sort="openCount" onSortChange={vi.fn()} />);
  });
  return container;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe('asset host unresolved severity indicator', () => {
  it('renders severity in desktop rows and mobile cards only when unresolved alerts exist', async () => {
    const host = await render([
      makeAsset('active.example.test', 'critical', 2, 0),
      makeAsset('resolved.example.test', null, 0, 1),
    ]);

    const mobileActiveCard = Array.from(host.querySelectorAll('ul li')).find((element) =>
      element.textContent?.includes('active.example.test'),
    );
    const desktopActiveRow = Array.from(host.querySelectorAll('tbody tr')).find((element) =>
      element.textContent?.includes('active.example.test'),
    );
    const mobileResolvedCard = Array.from(host.querySelectorAll('ul li')).find((element) =>
      element.textContent?.includes('resolved.example.test'),
    );
    const desktopResolvedRow = Array.from(host.querySelectorAll('tbody tr')).find((element) =>
      element.textContent?.includes('resolved.example.test'),
    );

    expect(mobileActiveCard?.querySelector('[data-testid="asset-unresolved-severity"]')?.textContent)
      .toBe('Severity critical');
    expect(desktopActiveRow?.querySelector('[data-testid="asset-unresolved-severity"]')?.textContent)
      .toBe('Severity critical');
    expect(mobileResolvedCard?.querySelector('[data-testid="asset-unresolved-severity"]')).toBeNull();
    expect(desktopResolvedRow?.querySelector('[data-testid="asset-unresolved-severity"]')).toBeNull();
  });
});
