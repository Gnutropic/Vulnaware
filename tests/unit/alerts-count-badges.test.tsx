// Rendering coverage for the /alerts severity count strip.
// The component receives the already-authorized API envelope; it does not
// perform data fetching itself.

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { AlertsCountBadges } from '@/components/dashboard/alerts-count-badges';
import type { AlertCounts } from '@/lib/contracts/alerts';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  if (container?.parentNode) container.parentNode.removeChild(container);
  container = null;
});

async function renderBadges(counts: AlertCounts | null) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<AlertsCountBadges counts={counts} />);
  });
  return container;
}

describe('AlertsCountBadges', () => {
  it('shows a loading skeleton for every count before the first response', async () => {
    const host = await renderBadges(null);

    expect(host.querySelectorAll('[aria-hidden="true"]')).toHaveLength(5);
    expect(host.textContent).toBe('');
  });

  it('renders all severity labels with returned values, including zeroes', async () => {
    const host = await renderBadges({
      critical: 4,
      high: 0,
      medium: 2,
      low: 0,
      snoozed: 1,
    });

    expect(host.textContent).toContain('Critical 4');
    expect(host.textContent).toContain('High 0');
    expect(host.textContent).toContain('Medium 2');
    expect(host.textContent).toContain('Low 0');
  });
});
