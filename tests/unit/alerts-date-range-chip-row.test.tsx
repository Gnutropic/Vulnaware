// Pure rendering smoke test for the date-range preset chip row. Locks
// the chip contract:
//   - 4 chips rendered in a labeled fieldset (All, Last 7d, Last 30d, Last 90d)
//   - active chip carries aria-pressed=true + data-active=true + variant=default
//   - inactive chips carry aria-pressed=false
//   - click on any chip calls onChange with the corresponding preset key
//   - re-clicking the already-active chip is allowed (parent decides)
//
// Renders through React's createRoot into jsdom; no DB, no apiFetch, no
// router — the chip is pure presentational + a controlled callback.
// Every render + click wraps in `await act(...)` so React 19's concurrent
// scheduler has actually flushed before the queries run.

// React 19 refuses `act(...)` unless the current test environment
// explicitly opts in via this flag — without setting it here the call
// emits a stderr warning AND silently flushes only some tree siblings,
// which is what makes the first two runs here fail their click-asserts.
// Set it before any React import to keep the act wrapper honest.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AlertsDateRangeChipRow,
  type DateRangePreset,
} from '@/components/dashboard/alerts-date-range-chip-row';

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

async function renderRow(value: DateRangePreset, onChange: (next: DateRangePreset) => void) {
  container = document.createElement('div');
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  await act(async () => {
    created.render(<AlertsDateRangeChipRow value={value} onChange={onChange} />);
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

describe('AlertsDateRangeChipRow', () => {
  it('renders four chips inside a labeled fieldset', async () => {
    const host = await renderRow(null, () => {});
    const fieldset = host.querySelector('fieldset');
    expect(fieldset).not.toBeNull();
    expect(fieldset?.getAttribute('aria-label')).toBe('Filter alerts by date range');
    const chips = chipButtons(host);
    expect(chips).toHaveLength(4);
    expect(chips.map((c) => c.textContent?.trim())).toEqual([
      'All',
      'Last 7d',
      'Last 30d',
      'Last 90d',
    ]);
  });

  it('marks only the active preset with aria-pressed=true and data-active=true', async () => {
    const host = await renderRow('30d', () => {});
    const chips = chipButtons(host);
    expect(chips.map((c) => c.getAttribute('aria-pressed'))).toEqual([
      'false',
      'false',
      'true',
      'false',
    ]);
    expect(chips.map((c) => c.getAttribute('data-active'))).toEqual([
      'false',
      'false',
      'true',
      'false',
    ]);
    // The active chip should use the brand-tinted `default` variant
    // (bg-primary), while the others stay on `outline` (no primary bg).
    expect(chips[0]?.className).not.toContain('bg-primary');
    expect(chips[1]?.className).not.toContain('bg-primary');
    expect(chips[2]?.className).toContain('bg-primary');
    expect(chips[3]?.className).not.toContain('bg-primary');
  });

  it('treats "null" as the all-active state', async () => {
    const host = await renderRow(null, () => {});
    const chips = chipButtons(host);
    expect(chips[0]?.getAttribute('aria-pressed')).toBe('true');
    for (const other of chips.slice(1)) {
      expect(other.getAttribute('aria-pressed')).toBe('false');
    }
    expect(chips[0]?.className).toContain('bg-primary');
  });

  it('calls onChange with the matching preset key when a chip is clicked', async () => {
    const calls: DateRangePreset[] = [];
    const host = await renderRow(null, (next) => {
      calls.push(next);
    });
    const chips = chipButtons(host);
    await clickChip(chips[0]);
    await clickChip(chips[1]);
    await clickChip(chips[2]);
    await clickChip(chips[3]);
    expect(calls).toEqual([null, '7d', '30d', '90d']);
  });

  it('still calls onChange when the active chip is re-clicked', async () => {
    const calls: DateRangePreset[] = [];
    const host = await renderRow('7d', (next) => {
      calls.push(next);
    });
    const chips = chipButtons(host);
    await clickChip(chips[1]);
    // The parent decides whether re-applying is a no-op; the chip still
    // surfaces the intent to re-set the preset.
    expect(calls).toEqual(['7d']);
  });
});
