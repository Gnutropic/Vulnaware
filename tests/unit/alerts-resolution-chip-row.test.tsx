// @polsia:user-owned — Focused contract test for the alerts resolution chips.

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AlertsResolutionChipRow,
} from '@/components/dashboard/alerts-resolution-chip-row';
import type { ResolutionFilter } from '@/lib/contracts/alerts';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

async function renderRow(value: ResolutionFilter, onChange: (next: ResolutionFilter) => void) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<AlertsResolutionChipRow value={value} onChange={onChange} />);
  });
  return container;
}

describe('AlertsResolutionChipRow', () => {
  it('renders all three labels in a labeled fieldset', async () => {
    const host = await renderRow('unresolved', () => {});
    expect(host.querySelector('fieldset')?.getAttribute('aria-label')).toBe(
      'Filter alerts by resolution status',
    );
    expect([...host.querySelectorAll('button')].map((button) => button.textContent?.trim())).toEqual([
      'All',
      'Unresolved',
      'Resolved',
    ]);
  });

  it('marks only the selected chip pressed and sends the clicked value', async () => {
    const changes: ResolutionFilter[] = [];
    const host = await renderRow('unresolved', (next) => changes.push(next));
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual([
      'false',
      'true',
      'false',
    ]);

    await act(async () => {
      buttons[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(changes).toEqual(['resolved']);
  });
});
