// Pure rendering test for the complete workflow status filter.
//   - active chip carries aria-pressed=true + data-active=true +
//     variant=default + the bg-primary class
//   - inactive chips carry aria-pressed=false + variant=outline +
//     the bg-primary-absent class
//   - each stored status and the derived Snoozed option call onChange
//     with its URL value; All calls onChange with null
//   - re-clicking the already-active chip is allowed (parent decides)
//
// Renders through React's createRoot into jsdom; no DB, no apiFetch, no
// router — the chip is pure presentational + a controlled callback.
// Every render + click wraps in `await act(...)` so React 19's concurrent
// scheduler has actually flushed before the queries run.

// React 19 refuses `act(...)` unless the current test environment
// explicitly opts in via this flag — without setting it here the call
// emits a stderr warning AND silently flushes only some tree siblings,
// which is what makes concurrent-row assertions flake. Set it before
// any React import to keep the act wrapper honest.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AlertsStatusChipRow,
  type StatusFilter,
} from '@/components/dashboard/alerts-status-chip-row';

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

async function renderRow(
  value: StatusFilter,
  onChange: (next: StatusFilter) => void,
  includeOpen = true,
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  await act(async () => {
    created.render(
      <AlertsStatusChipRow value={value} onChange={onChange} includeOpen={includeOpen} />,
    );
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

describe('AlertsStatusChipRow', () => {
  it('renders every workflow status and All inside a labeled fieldset', async () => {
    const host = await renderRow(null, () => {});
    const fieldset = host.querySelector('fieldset');
    expect(fieldset).not.toBeNull();
    expect(fieldset?.getAttribute('aria-label')).toBe('Filter alerts by status');
    const chips = chipButtons(host);
    expect(chips).toHaveLength(6);
    expect(chips.map((c) => c.textContent?.trim())).toEqual([
      'All',
      'Open',
      'In Progress',
      'Resolved',
      'False Positive',
      'Snoozed',
    ]);
  });

  it('keeps the shared status row unchanged where Open was not requested', async () => {
    const host = await renderRow(null, () => {}, false);
    expect(chipButtons(host).map((chip) => chip.textContent?.trim())).toEqual([
      'All',
      'In Progress',
      'Resolved',
      'False Positive',
      'Snoozed',
    ]);
  });

  it.each([
    ['open', 1],
    ['in_progress', 2],
    ['resolved', 3],
    ['false_positive', 4],
    ['snoozed', 5],
  ] as const)('marks status=%s as the only active option', async (status, selectedIndex) => {
    const host = await renderRow(status, () => {});
    const chips = chipButtons(host);
    expect(chips.map((chip) => chip.getAttribute('aria-pressed'))).toEqual(
      chips.map((_, index) => String(index === selectedIndex)),
    );
    expect(chips.map((chip) => chip.getAttribute('data-active'))).toEqual(
      chips.map((_, index) => String(index === selectedIndex)),
    );
    // The active chip should use the brand-tinted `default` variant
    // (bg-primary), while the others stay on `outline` (no primary bg).
    for (const [index, chip] of chips.entries()) {
      if (index === selectedIndex) expect(chip.className).toContain('bg-primary');
      else expect(chip.className).not.toContain('bg-primary');
    }
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

  it('calls onChange with the matching status key (null for "All") when a chip is clicked', async () => {
    const calls: StatusFilter[] = [];
    const host = await renderRow(null, (next) => {
      calls.push(next);
    });
    const chips = chipButtons(host);
    await clickChip(chips[0]);
    await clickChip(chips[1]);
    await clickChip(chips[2]);
    await clickChip(chips[3]);
    await clickChip(chips[4]);
    await clickChip(chips[5]);
    expect(calls).toEqual([null, 'open', 'in_progress', 'resolved', 'false_positive', 'snoozed']);
  });

  it('still calls onChange when the active chip is re-clicked', async () => {
    const calls: StatusFilter[] = [];
    const host = await renderRow('resolved', (next) => {
      calls.push(next);
    });
    const chips = chipButtons(host);
    // `Resolved` is index 3 in the status menu.
    await clickChip(chips[3]);
    // The parent decides whether re-applying is a no-op; the chip still
    // surfaces the intent to re-set the status.
    expect(calls).toEqual(['resolved']);
  });

  it('false_positive chip can be activated and re-emits the FP key on click', async () => {
    const calls: StatusFilter[] = [];
    const host = await renderRow('false_positive', (next) => {
      calls.push(next);
    });
    const chips = chipButtons(host);
    // The False Positive chip is index 4.
    expect(chips[4]?.getAttribute('aria-pressed')).toBe('true');
    expect(chips[4]?.className).toContain('bg-primary');
    await clickChip(chips[4]);
    expect(calls).toEqual(['false_positive']);
  });

  it('snoozed chip can be activated and re-emits the snoozed key on click', async () => {
    // Brief: the new `Snoozed` chip on `AlertsStatusChipRow` emits
    // `?status=snoozed` from the enum chip family rather than the
    // boolean-flag row's `?snoozed=1`. Both routes resolve the
    // literal to the same `snoozedUntil > now` predicate, so
    // a chip click surfaces the same effective query.
    const calls: StatusFilter[] = [];
    const host = await renderRow('snoozed', (next) => {
      calls.push(next);
    });
    const chips = chipButtons(host);
    // Snoozed remains a selectable, derived status in the menu.
    expect(chips[5]?.getAttribute('aria-pressed')).toBe('true');
    expect(chips[5]?.className).toContain('bg-primary');
    expect(chips[5]?.textContent?.trim()).toBe('Snoozed');
    await clickChip(chips[5]);
    // Re-click re-emits the literal (parent decides whether
    // re-applying is a no-op; the chip surfaces the intent).
    expect(calls).toEqual(['snoozed']);
  });
});
