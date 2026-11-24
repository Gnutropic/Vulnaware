// Pure rendering smoke test for the trailing-days ("Last 7 days") chip
// row on /alerts. Locks the chip contract:
//   - 2 chips rendered in a labeled fieldset ("All", "Last 7d")
//   - active chip carries aria-pressed=true + data-active=true + bg-primary
//   - "All" maps to `null` (NOT the string 'all'), so the page's
//     `effectiveQs` strips `?since=` on the resting state
//   - "Last 7d" maps to `'7d'`
//   - re-clicking the already-active chip still fires onChange (parent
//     decides whether the flip is a no-op)
//   - composes with sibling chip rows — sibling chip rows are NOT
//     rendered here (single-component render); the integration test
//     covers the composed URL round-trip via buildEffectiveQs.
//
// Renders through React's createRoot into jsdom; no DB, no apiFetch,
// no router — chip is pure presentational + a controlled callback.
// Every render + click wraps in `await act(...)` so React 19's
// concurrent scheduler has actually flushed before the queries run.

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { AlertsSinceChipRow, type SinceFilter } from '@/components/dashboard/alerts-since-chip-row';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  if (container?.parentNode) {
    container.parentNode.removeChild(container);
  }
  container = null;
});

async function renderRow(value: SinceFilter, onChange: (next: SinceFilter) => void) {
  container = document.createElement('div');
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  await act(async () => {
    created.render(<AlertsSinceChipRow value={value} onChange={onChange} />);
  });
  return container;
}

function chipButtons(host: HTMLElement): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll('button'));
}

async function clickChip(button: HTMLButtonElement | null | undefined) {
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('AlertsSinceChipRow', () => {
  it('renders two chips inside a labeled fieldset', async () => {
    const host = await renderRow(null, () => {});
    const fieldset = host.querySelector('fieldset');
    expect(fieldset).not.toBeNull();
    expect(fieldset?.getAttribute('aria-label')).toBe('Filter alerts by trailing days');
    const chips = chipButtons(host);
    expect(chips).toHaveLength(2);
    expect(chips.map((c) => c.textContent?.trim())).toEqual(['All', 'Last 7d']);
  });

  it('marks only the active chip with aria-pressed=true and data-active=true', async () => {
    const host = await renderRow('7d', () => {});
    const chips = chipButtons(host);
    expect(chips.map((c) => c.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    expect(chips.map((c) => c.getAttribute('data-active'))).toEqual(['false', 'true']);
    expect(chips[0]?.className).not.toContain('bg-primary');
    expect(chips[1]?.className).toContain('bg-primary');
  });

  it('treats "null" as the all-active state', async () => {
    const host = await renderRow(null, () => {});
    const chips = chipButtons(host);
    expect(chips[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(chips[1]?.getAttribute('aria-pressed')).toBe('false');
    expect(chips[0]?.className).toContain('bg-primary');
    expect(chips[1]?.className).not.toContain('bg-primary');
  });

  it('calls onChange with null for "All" and "7d" for "Last 7d"', async () => {
    const calls: SinceFilter[] = [];
    const host = await renderRow(null, (next) => {
      calls.push(next);
    });
    const chips = chipButtons(host);
    await clickChip(chips[0]);
    await clickChip(chips[1]);
    expect(calls).toEqual([null, '7d']);
  });

  it('still calls onChange when the active chip is re-clicked', async () => {
    const calls: SinceFilter[] = [];
    const host = await renderRow('7d', (next) => {
      calls.push(next);
    });
    const chips = chipButtons(host);
    await clickChip(chips[1]);
    expect(calls).toEqual(['7d']);
  });
});
