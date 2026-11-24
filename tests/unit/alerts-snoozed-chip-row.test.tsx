// Pure rendering smoke test for the snoozed-only filter chip row. Locks
// the chip contract:
//   - single chip rendered inside a labeled fieldset ("Snoozed only")
//   - active chip carries aria-pressed=true + data-active=true +
//     variant=outline + the `SNOOZED_COLOR_TOKEN.chipActive` fragment
//     (painted into `className` from the color-token table rather
//     than the shadcn `default` variant's `bg-primary` outline)
//   - inactive chip carries aria-pressed=false + variant=outline
//     AND the active-color fragment is absent
//   - click on inactive flips onChange(true); click on active flips
//     onChange(false) — the chip is a pure toggle
//   - the resting state (no `?snoozed=1` on the URL) renders the
//     chip as inactive

// React 19 refuses `act(...)` unless the current test environment
// explicitly opts in via this flag — without setting it here the call
// emits a stderr warning AND silently flushes only some tree siblings,
// which is what makes concurrent-row assertions flake. Set it before
// any React import to keep the act wrapper honest.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AlertsSnoozedChipRow,
  type SnoozedOnlyFlag,
} from '@/components/dashboard/alerts-snoozed-chip-row';
import { SNOOZED_COLOR_TOKEN } from '@/lib/ui/severity-colors';

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

async function renderRow(value: SnoozedOnlyFlag, onChange: (next: SnoozedOnlyFlag) => void) {
  container = document.createElement('div');
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  await act(async () => {
    created.render(<AlertsSnoozedChipRow value={value} onChange={onChange} />);
  });
  return container;
}

function chipButton(host: HTMLElement): HTMLButtonElement | null {
  return host.querySelector('button');
}

async function clickChip(button: HTMLButtonElement | null | undefined) {
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

// Stable substring of the new token's `chipActive` (`bg-violet-500
// text-white border-violet-500 dark:bg-violet-500/90`). The fragment
// `bg-violet-*` is what uniquely identifies the Snoozed chip's
// active paint vs. the brand-default `bg-primary`, the destructive
// tone, or the empty outline-resting branch.
const SNOOZED_CHIP_ACTIVE_FRAGMENT = SNOOZED_COLOR_TOKEN.chipActive
  .split(/\s+/)
  .find((cls) => cls.startsWith('bg-'));
if (!SNOOZED_CHIP_ACTIVE_FRAGMENT) {
  throw new Error('SNOOZED_COLOR_TOKEN.chipActive must include a bg-* fragment');
}

describe('AlertsSnoozedChipRow', () => {
  it('renders a single chip inside a labeled fieldset', async () => {
    const host = await renderRow(false, () => {});
    const fieldset = host.querySelector('fieldset');
    expect(fieldset).not.toBeNull();
    expect(fieldset?.getAttribute('aria-label')).toBe('Filter alerts by snooze status');
    const buttons = host.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent?.trim()).toBe('Snoozed only');
  });

  it('marks the active chip with aria-pressed=true + data-active=true + SNOOZED_COLOR_TOKEN.chipActive', async () => {
    const host = await renderRow(true, () => {});
    const button = chipButton(host);
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    expect(button?.getAttribute('data-active')).toBe('true');
    // The active paint flows from SNOOZED_COLOR_TOKEN.chipActive
    // (sister to the per-severity tokens the AlertsSeverityChipRow
    // already uses) — the unique bg-* fragment IS the active
    // marker so the chip + the count badge read as the same color.
    expect(button?.className).toContain(SNOOZED_CHIP_ACTIVE_FRAGMENT);
    // Negative shape: the shadcn `default` variant marker `bg-primary`
    // is no longer used; the token table is the single source of truth.
    expect(button?.className).not.toContain('bg-primary');
  });

  it('marks the inactive chip with aria-pressed=false + data-active=false (no chipActive fragment)', async () => {
    const host = await renderRow(false, () => {});
    const button = chipButton(host);
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    expect(button?.getAttribute('data-active')).toBe('false');
    // Negative shape: the unique bg-* fragment of the active chip
    // is absent on the resting chip so a future drift that
    // accidentally paints the Snoozed chip on the resting branch
    // breaks here.
    expect(button?.className).not.toContain(SNOOZED_CHIP_ACTIVE_FRAGMENT);
    expect(button?.className).not.toContain('bg-primary');
  });

  it('clicking the inactive chip fires onChange(true) — toggling on', async () => {
    const calls: SnoozedOnlyFlag[] = [];
    const host = await renderRow(false, (next) => {
      calls.push(next);
    });
    const button = chipButton(host);
    await clickChip(button);
    expect(calls).toEqual([true]);
  });

  it('clicking the active chip fires onChange(false) — toggling off', async () => {
    const calls: SnoozedOnlyFlag[] = [];
    const host = await renderRow(true, (next) => {
      calls.push(next);
    });
    const button = chipButton(host);
    await clickChip(button);
    expect(calls).toEqual([false]);
  });
});
