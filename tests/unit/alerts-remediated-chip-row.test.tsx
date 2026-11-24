// Pure rendering smoke test for the remediated-only filter chip row. Locks
// the chip contract:
//   - single chip rendered inside a labeled fieldset ("Remediated only")
//   - active chip carries aria-pressed=true + data-active=true +
//     variant=default (and the bg-primary outline class)
//   - inactive chip carries aria-pressed=false + variant=outline
//   - click on inactive flips onChange(true); click on active flips
//     onChange(false) — the chip is a pure toggle
//   - the resting state (no `?remediated=1` on the URL) renders the
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
  AlertsRemediatedChipRow,
  type RemediatedOnlyFlag,
} from '@/components/dashboard/alerts-remediated-chip-row';

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

async function renderRow(value: RemediatedOnlyFlag, onChange: (next: RemediatedOnlyFlag) => void) {
  container = document.createElement('div');
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  await act(async () => {
    created.render(<AlertsRemediatedChipRow value={value} onChange={onChange} />);
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

describe('AlertsRemediatedChipRow', () => {
  it('renders a single chip inside a labeled fieldset', async () => {
    const host = await renderRow(false, () => {});
    const fieldset = host.querySelector('fieldset');
    expect(fieldset).not.toBeNull();
    expect(fieldset?.getAttribute('aria-label')).toBe('Filter alerts by remediation');
    const buttons = host.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent?.trim()).toBe('Remediated only');
  });

  it('marks the active chip with aria-pressed=true + data-active=true + bg-primary', async () => {
    const host = await renderRow(true, () => {});
    const button = chipButton(host);
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    expect(button?.getAttribute('data-active')).toBe('true');
    // `bg-primary` is the shadcn `default`-variant marker the
    // chip row tests pin against — every other variant is `outline`.
    expect(button?.className).toContain('bg-primary');
  });

  it('marks the inactive chip with aria-pressed=false + data-active=false (no bg-primary)', async () => {
    const host = await renderRow(false, () => {});
    const button = chipButton(host);
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    expect(button?.getAttribute('data-active')).toBe('false');
    expect(button?.className).not.toContain('bg-primary');
  });

  it('clicking the inactive chip fires onChange(true) — toggling on', async () => {
    const calls: RemediatedOnlyFlag[] = [];
    const host = await renderRow(false, (next) => {
      calls.push(next);
    });
    const button = chipButton(host);
    await clickChip(button);
    expect(calls).toEqual([true]);
  });

  it('clicking the active chip fires onChange(false) — toggling off', async () => {
    const calls: RemediatedOnlyFlag[] = [];
    const host = await renderRow(true, (next) => {
      calls.push(next);
    });
    const button = chipButton(host);
    await clickChip(button);
    expect(calls).toEqual([false]);
  });
});
