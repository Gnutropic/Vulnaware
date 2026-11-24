// Component-render tests for the /alerts page's bulk-snooze surface.
// Mirrors the bulk-resolve approach in tests/unit/alerts-bulk-resolve
// .test.tsx (render the bar/cards in jsdom, drive the click handlers
// against a stub, verify the surface):
//
//   - The single `AlertsBulkActionBar` `Snooze` trigger button opens a
//     Radix popover with four options (1d / 3d / 7d / 30d) — wired
//     end-to-end so the popover's literals match the shared
//     `SnoozeDuration` schema, the bulk route's `WINDOW_MS` table, and
//     the helper's `BulkSnoozeInput.duration`.
//   - Clicking an option fires `onSnooze(<literal>)` for that option.
//   - The trigger AND every option inside the popover are disabled
//     while `pending` is true so a fast double-click can't queue a
//     second fan-out (the popover's controlled `open` flips closed
//     BEFORE the parent fan-out fires so a re-click after pick can't
//     queue a second fan-out either).
//   - `runBulkSnooze` (the helper-level scenarios in
//     alerts-bulk-snooze-helper.test.ts) covers the wire-level fetch
//     + envelope parse + optimistic-flip contract end-to-end; this
//     file stays at the bar surface so the assertions run fast and
//     don't depend on the full page island (useRouter/useSearchParams
//     /apiFetch + the chip row chain).

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlertsBulkActionBar } from '@/components/dashboard/alerts-bulk-action-bar';
import type { SnoozeDuration } from '@/lib/contracts/alerts';

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

async function renderBar(
  props: Partial<Parameters<typeof AlertsBulkActionBar>[0]> & {
    onResolve?: () => void;
    onReopenSelected?: () => void;
    onMarkFalsePositive?: () => void;
    onSnooze?: (duration: SnoozeDuration) => void;
    onSnoozeUntil?: (until: string) => void;
    onClear?: () => void;
  },
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  await act(async () => {
    created.render(<AlertsBulkActionBar {...props} />);
  });
  return container;
}

async function click(target: Element | null | undefined) {
  await act(async () => {
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function openPicker(host: HTMLElement) {
  // Click the popover trigger to flip the controlled `open` state to
  // true. Radix's PopoverTrigger listens for the standard `click`
  // event so a MouseEvent('click') is the right shape.
  await click(host.querySelector('[data-testid="bulk-snooze-picker-cta"]'));
}

function queryPickerNode<T extends Element = Element>(selector: string): T | null {
  // PopoverContent is portalled into document.body, so options live
  // outside the rendered host container. Query the full document so
  // portalled content is reachable without portal-shim wiring.
  return document.querySelector<T>(selector);
}

describe('AlertsBulkActionBar — bulk-snooze picker', () => {
  it('renders nothing when selectionCount is zero', async () => {
    const host = await renderBar({
      selectionCount: 0,
      results: new Map(),
      pending: false,
      onResolve: () => {},
      onClear: () => {},
    });
    expect(host.firstChild).toBeNull();
  });

  it('mounts a Snooze trigger plus a 1d / 3d / 7d / 30d popover with four options', async () => {
    const host = await renderBar({
      selectionCount: 3,
      results: new Map(),
      pending: false,
      onResolve: () => {},
      onReopenSelected: () => {},
      onMarkFalsePositive: () => {},
      onSnooze: () => {},
      onClear: () => {},
    });
    // Snooze affordance is now a single trigger (not three flat
    // buttons) — pin the trigger testid so a future drift back to
    // three flat buttons fails this assertion.
    expect(host.querySelector('[data-testid="bulk-snooze-picker-cta"]')).not.toBeNull();
    // Open the popover and verify the four option testids + labels.
    await openPicker(host);
    expect(queryPickerNode('[data-testid="bulk-snooze-pick-1d"]')).not.toBeNull();
    expect(queryPickerNode('[data-testid="bulk-snooze-pick-3d"]')).not.toBeNull();
    expect(queryPickerNode('[data-testid="bulk-snooze-pick-7d"]')).not.toBeNull();
    expect(queryPickerNode('[data-testid="bulk-snooze-pick-30d"]')).not.toBeNull();
    // Sanity: the rest of the bar still mounts alongside the picker.
    expect(host.querySelector('[data-testid="bulk-reopen-cta"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="bulk-false-positive-cta"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="bulk-resolve-cta"]')).not.toBeNull();
    // Visible labels read from the picker content (portalled into body).
    const pickerText = (
      queryPickerNode('[data-testid="bulk-snooze-picker-content"]')?.textContent ?? ''
    ).toLowerCase();
    expect(pickerText).toContain('snooze 1d');
    expect(pickerText).toContain('snooze 3d');
    expect(pickerText).toContain('snooze 7d');
    expect(pickerText).toContain('snooze 30d');
  });

  it('opens the picker on trigger click; clicking each option fires onSnooze with the matching literal', async () => {
    const snooze = vi.fn();
    const host = await renderBar({
      selectionCount: 2,
      results: new Map(),
      pending: false,
      onResolve: () => {},
      onReopenSelected: () => {},
      onMarkFalsePositive: () => {},
      onSnooze: snooze,
      onClear: () => {},
    });
    // Each option pick closes the popover (controlled `open` flips
    // to false BEFORE the parent fan-out fires), so the next pick
    // requires a fresh open between attempts — open the trigger each
    // time so a future drift that left the popover open across picks
    // surfaces here.
    await openPicker(host);
    await click(queryPickerNode('[data-testid="bulk-snooze-pick-1d"]'));
    await openPicker(host);
    await click(queryPickerNode('[data-testid="bulk-snooze-pick-3d"]'));
    await openPicker(host);
    await click(queryPickerNode('[data-testid="bulk-snooze-pick-7d"]'));
    await openPicker(host);
    await click(queryPickerNode('[data-testid="bulk-snooze-pick-30d"]'));
    expect(vi.mocked(snooze).mock.calls).toEqual([['1d'], ['3d'], ['7d'], ['30d']]);
  });

  it('disables the Snooze trigger (and every other CTA) while pending', async () => {
    const host = await renderBar({
      selectionCount: 2,
      results: new Map(),
      pending: true,
      onResolve: () => {},
      onReopenSelected: () => {},
      onMarkFalsePositive: () => {},
      onSnooze: () => {},
      onClear: () => {},
    });
    const trigger = host.querySelector('[data-testid="bulk-snooze-picker-cta"]');
    expect(trigger?.hasAttribute('disabled')).toBe(true);
    expect(trigger?.getAttribute('aria-disabled')).toBe('true');
    for (const id of [
      'bulk-reopen-cta',
      'bulk-false-positive-cta',
      'bulk-remediate-cta',
      'bulk-take-ownership-cta',
      'bulk-resolve-cta',
    ]) {
      const btn = host.querySelector(`[data-testid="${id}"]`);
      expect(btn?.hasAttribute('disabled')).toBe(true);
    }
  });

  it('options menu: every option is disabled while pending, so a stale picker click cannot queue a fan-out', async () => {
    // Mirror of the trigger-disabled assertion above, against the
    // picker options themselves: even if the popover were open when
    // a fan-out starts, a click on any option while `pending` is
    // true cannot fire onSnooze. The bar's `pending` prop is the
    // authoritative defensive gate.
    container = document.createElement('div');
    document.body.appendChild(container);
    const created = createRoot(container);
    root = created;
    await act(async () => {
      created.render(
        <AlertsBulkActionBar
          selectionCount={2}
          results={new Map()}
          pending={false}
          onResolve={() => {}}
          onReopenSelected={() => {}}
          onMarkFalsePositive={() => {}}
          onSnooze={() => {}}
          onClear={() => {}}
        />,
      );
    });
    await openPicker(container as unknown as HTMLElement);
    // Sanity: options render with pending=false so we can verify the
    // pick-1d option existed BEFORE flipping pending to true.
    expect(queryPickerNode('[data-testid="bulk-snooze-pick-1d"]')).not.toBeNull();
    // Re-render with pending:true. Component state (`snoozeOpen`) is
    // preserved across re-renders, so the popover remains open and
    // the option still mounts — but now `disabled` and `aria-disabled`
    // are set on every option so a stale browser-driven click
    // cannot reach the parent's fan-out.
    await act(async () => {
      created.render(
        <AlertsBulkActionBar
          selectionCount={2}
          results={new Map()}
          pending={true}
          onResolve={() => {}}
          onReopenSelected={() => {}}
          onMarkFalsePositive={() => {}}
          onSnooze={() => {}}
          onClear={() => {}}
        />,
      );
    });
    for (const key of ['1d', '3d', '7d', '30d']) {
      const option = queryPickerNode(`[data-testid="bulk-snooze-pick-${key}"]`);
      expect(option?.hasAttribute('disabled')).toBe(true);
      expect(option?.getAttribute('aria-disabled')).toBe('true');
    }
  });

  it('renders the "Snoozing…" pending label on the Snooze trigger while pending', async () => {
    const host = await renderBar({
      selectionCount: 2,
      results: new Map(),
      pending: true,
      onResolve: () => {},
      onReopenSelected: () => {},
      onMarkFalsePositive: () => {},
      onSnooze: () => {},
      onClear: () => {},
    });
    const text = (host.textContent ?? '').toLowerCase();
    // The single trigger swaps the "Snooze" label for the
    // pending-state Loader2 + "Snoozing…" pattern, matching the swap
    // the Reopen/Resolve CTAs use.
    expect(text).toContain('snoozing');
    // The idle "Snooze" label MUST NOT render while pending — a copy-
    // paste drift that keeps both labels would surface here.
    const trigger = host.querySelector('[data-testid="bulk-snooze-picker-cta"]');
    expect(trigger?.textContent?.toLowerCase()).toContain('snoozing');
    expect(trigger?.textContent?.toLowerCase()).not.toMatch(/^snooze$/);
  });
});

// ============ Custom-date (until) arm ============
// Cover the popover's `<input type="date">` + Apply button posture:
//   - input renders with `min=today`
//   - Apply starts disabled when the input is empty
//   - Apply stays disabled with a past value (UI gate)
//   - Apply fires `onSnoozeUntil(<ISO>)` on a future pick and closes
//     the popover before emitting
//   - popover closes on Apply so a stale re-click can't queue a second
//     fan-out mid-flight
//   - input + Apply disabled while `pending: true`
//
// We don't import the helper here — `alerts-bulk-snooze-helper.test.ts`
// owns the wire-level fetch + envelope parse + optimistic-flip
// assertions. This file stays at the bar surface.

describe('AlertsBulkActionBar — bulk-snooze custom-date picker', () => {
  it('mounts the custom-date section: <input type="date"> + Apply button', async () => {
    const host = await renderBar({
      selectionCount: 3,
      results: new Map(),
      pending: false,
      onResolve: () => {},
      onReopenSelected: () => {},
      onMarkFalsePositive: () => {},
      onSnooze: () => {},
      onSnoozeUntil: () => {},
      onClear: () => {},
    });
    await openPicker(host);
    // Date input is rendered inside the popover.
    const input = queryPickerNode<HTMLInputElement>('[data-testid="bulk-snooze-until-input"]');
    expect(input).not.toBeNull();
    expect(input?.getAttribute('type')).toBe('date');
    const today = new Date().toISOString().slice(0, 10);
    expect(input?.getAttribute('min')).toBe(today);
    // Apply button is also rendered.
    const apply = queryPickerNode('[data-testid="bulk-snooze-until-apply"]');
    expect(apply).not.toBeNull();
    // Apply starts disabled (no value typed).
    expect(apply?.hasAttribute('disabled')).toBe(true);
  });

  it('Apply stays disabled when typed value parses to a past date (UI gate)', async () => {
    const host = await renderBar({
      selectionCount: 2,
      results: new Map(),
      pending: false,
      onResolve: () => {},
      onReopenSelected: () => {},
      onMarkFalsePositive: () => {},
      onSnooze: () => {},
      onSnoozeUntil: () => {},
      onClear: () => {},
    });
    await openPicker(host);
    const input = queryPickerNode<HTMLInputElement>('[data-testid="bulk-snooze-until-input"]');
    const apply = queryPickerNode('[data-testid="bulk-snooze-until-apply"]');
    expect(input).not.toBeNull();
    expect(apply).not.toBeNull();
    // Type a past date — jsdom reflects React's onChange -> setState
    // path so the input's value updates. The bar's
    // `snoozeUntilValid` derive returns false on past dates, keeping
    // Apply disabled even though the input has a value.
    const PAST = '2020-01-01';
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      nativeSetter?.call(input, PAST);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      input?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(input?.value).toBe(PAST);
    // Apply is still disabled because the past date fails the
    // client-side gate (todayIso comparison).
    expect(apply?.hasAttribute('disabled')).toBe(true);
  });

  it('Apply fires onSnoozeUntil(<future ISO>) on a future pick and closes the popover', async () => {
    const snoozeUntil = vi.fn();
    const host = await renderBar({
      selectionCount: 2,
      results: new Map(),
      pending: false,
      onResolve: () => {},
      onReopenSelected: () => {},
      onMarkFalsePositive: () => {},
      onSnooze: () => {},
      onSnoozeUntil: snoozeUntil,
      onClear: () => {},
    });
    await openPicker(host);
    const input = queryPickerNode<HTMLInputElement>('[data-testid="bulk-snooze-until-input"]');
    const apply = queryPickerNode('[data-testid="bulk-snooze-until-apply"]');
    expect(input).not.toBeNull();
    expect(apply).not.toBeNull();
    // Type a future date (one year + 1 day out so it's robust to
    // clock drift and timezone offset).
    const FUTURE = new Date(Date.now() + 366 * 86_400_000).toISOString().slice(0, 10);
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      nativeSetter?.call(input, FUTURE);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      input?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // Apply is now enabled.
    expect(apply?.hasAttribute('disabled')).toBe(false);
    // Click Apply → fires onSnoozeUntil(<future ISO>) once.
    await click(apply);
    expect(vi.mocked(snoozeUntil).mock.calls).toEqual([[FUTURE]]);
    // Popover closes after Apply so a stale browser-driven re-click
    // can't queue a second fan-out. The picker content is torn down.
    expect(queryPickerNode('[data-testid="bulk-snooze-until-apply"]')).toBeNull();
  });

  it('input + Apply are disabled while pending (parallel posture to the preset buttons)', async () => {
    // Mirror of the existing "options menu: every option is disabled
    // while pending" test shape: open the pickover BEFORE flipping
    // pending so the trigger's own disabled gate (which would
    // refuse the open click) doesn't fail the test before we can
    // verify the input + button carries the disabled posture.
    container = document.createElement('div');
    document.body.appendChild(container);
    const created = createRoot(container);
    root = created;
    await act(async () => {
      created.render(
        <AlertsBulkActionBar
          selectionCount={2}
          results={new Map()}
          pending={false}
          onResolve={() => {}}
          onReopenSelected={() => {}}
          onMarkFalsePositive={() => {}}
          onSnooze={() => {}}
          onSnoozeUntil={() => {}}
          onClear={() => {}}
        />,
      );
    });
    await openPicker(container as unknown as HTMLElement);
    // Sanity: the custom-date section renders BEFORE flipping
    // pending so we can verify the gate afterwards.
    expect(queryPickerNode('[data-testid="bulk-snooze-until-input"]')).not.toBeNull();
    expect(queryPickerNode('[data-testid="bulk-snooze-until-apply"]')).not.toBeNull();
    // Re-render with pending:true. Component state (snoozeOpen) is
    // preserved across re-renders, so the popover remains open and
    // the input + Apply button still mount — but now both carry
    // the disabled attribute so a stale browser-driven click can't
    // smuggle a second fan-out.
    await act(async () => {
      created.render(
        <AlertsBulkActionBar
          selectionCount={2}
          results={new Map()}
          pending={true}
          onResolve={() => {}}
          onReopenSelected={() => {}}
          onMarkFalsePositive={() => {}}
          onSnooze={() => {}}
          onSnoozeUntil={() => {}}
          onClear={() => {}}
        />,
      );
    });
    const input = queryPickerNode<HTMLInputElement>('[data-testid="bulk-snooze-until-input"]');
    const apply = queryPickerNode('[data-testid="bulk-snooze-until-apply"]');
    expect(input?.hasAttribute('disabled')).toBe(true);
    expect(apply?.hasAttribute('disabled')).toBe(true);
    expect(apply?.getAttribute('aria-disabled')).toBe('true');
  });

  it('picking a preset option clears the date input so a fresh open never lingers on the prior pick', async () => {
    // The popover's controlled `open` flips closed BEFORE the parent
    // fan-out fires — same pattern as the preset buttons. The
    // additional check: typing a value then clicking a preset option
    // also resets the input (so a stale value doesn't re-arm the
    // Apply button on a fresh popover open).
    const snooze = vi.fn();
    const snoozeUntil = vi.fn();
    const host = await renderBar({
      selectionCount: 2,
      results: new Map(),
      pending: false,
      onResolve: () => {},
      onReopenSelected: () => {},
      onMarkFalsePositive: () => {},
      onSnooze: snooze,
      onSnoozeUntil: snoozeUntil,
      onClear: () => {},
    });
    await openPicker(host);
    const input = queryPickerNode<HTMLInputElement>('[data-testid="bulk-snooze-until-input"]');
    expect(input).not.toBeNull();
    const FUTURE = new Date(Date.now() + 366 * 86_400_000).toISOString().slice(0, 10);
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      nativeSetter?.call(input, FUTURE);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      input?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(input?.value).toBe(FUTURE);
    // Click one of the preset options (e.g. 7d).
    await click(queryPickerNode('[data-testid="bulk-snooze-pick-7d"]'));
    expect(vi.mocked(snooze).mock.calls).toEqual([['7d']]);
    // Popover closed → re-open and inspect the input's value.
    await openPicker(host);
    const inputAfter = queryPickerNode<HTMLInputElement>('[data-testid="bulk-snooze-until-input"]');
    expect(inputAfter?.value).toBe('');
    // onSnoozeUntil must NOT have fired when the preset was picked.
    expect(vi.mocked(snoozeUntil)).not.toHaveBeenCalled();
  });
});
