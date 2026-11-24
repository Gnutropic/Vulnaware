// Component-render tests for the /alerts page's bulk-remediate
// surface. Mirrors the bulk-snooze approach in
// tests/unit/alerts-bulk-snooze.test.tsx (render the bar in jsdom,
// drive the click handlers against a stub, verify the surface):
//
//   - The `AlertsBulkActionBar` rendering mounts the new "Mark
//     remediated" outlined button between the Snooze popover and
//     Resolve.
//   - Clicking it fires the matching `onRemediate` callback.
//   - All buttons (Reopen, FP, Snooze trigger + 4 picker options,
//     Remediate, Resolve) are disabled while `pending` is true so a
//     fast double-click can't queue a second fan-out.
//   - The bar swaps to a "Remediating…" pending label while the
//     fan-out is in flight.
//   - `runBulkRemediate` (the helper-level scenarios in
//     alerts-bulk-remediate-helper.test.ts) covers the wire-level
//     fetch + envelope parse + optimistic-flip contract end-to-
//     end; this file stays at the bar surface so the assertions
//     run fast and don't depend on the full page island
//     (useRouter/useSearchParams/apiFetch + the chip row chain).

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
    onRemediate?: () => void;
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

function queryDoc<T extends Element = Element>(selector: string): T | null {
  // Snooze picker content is portalled via Radix Popover into
  // document.body, so tests that need the option buttons must look
  // beyond the rendered host subtree.
  return document.querySelector<T>(selector);
}

describe('AlertsBulkActionBar — bulk-remediate button', () => {
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

  it('mounts the "Mark remediated" outlined button between the Snooze picker and Resolve', async () => {
    const host = await renderBar({
      selectionCount: 3,
      results: new Map(),
      pending: false,
      onResolve: () => {},
      onReopenSelected: () => {},
      onMarkFalsePositive: () => {},
      onSnooze: () => {},
      onRemediate: () => {},
      onClear: () => {},
    });
    // The Remediate CTA renders by its data-testid.
    expect(host.querySelector('[data-testid="bulk-remediate-cta"]')).not.toBeNull();
    // The Snooze affordance is now a single trigger (not three flat
    // buttons) — pin the trigger testid so a future drift back to
    // three flat buttons fails this assertion.
    expect(host.querySelector('[data-testid="bulk-snooze-picker-cta"]')).not.toBeNull();
    // Sanity: the rest of the bar still mounts alongside the picker.
    expect(host.querySelector('[data-testid="bulk-reopen-cta"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="bulk-false-positive-cta"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="bulk-resolve-cta"]')).not.toBeNull();
    // Open the popover so the four option buttons are reachable.
    await click(host.querySelector('[data-testid="bulk-snooze-picker-cta"]'));
    expect(queryDoc('[data-testid="bulk-snooze-pick-1d"]')).not.toBeNull();
    expect(queryDoc('[data-testid="bulk-snooze-pick-3d"]')).not.toBeNull();
    expect(queryDoc('[data-testid="bulk-snooze-pick-7d"]')).not.toBeNull();
    expect(queryDoc('[data-testid="bulk-snooze-pick-30d"]')).not.toBeNull();
    // Visible label.
    const text = (host.textContent ?? '').toLowerCase();
    expect(text).toContain('mark remediated');
  });

  it('fires the onRemediate callback when the new CTA is clicked', async () => {
    const remediate = vi.fn();
    const host = await renderBar({
      selectionCount: 2,
      results: new Map(),
      pending: false,
      onResolve: () => {},
      onReopenSelected: () => {},
      onMarkFalsePositive: () => {},
      onSnooze: () => {},
      onRemediate: remediate,
      onClear: () => {},
    });
    await click(host.querySelector('[data-testid="bulk-remediate-cta"]'));
    expect(remediate).toHaveBeenCalledTimes(1);
  });

  it('disables the Remediate CTA (and every other CTA) while pending', async () => {
    // Render pending:false and open the popover, then re-render with
    // pending:true so the trigger is disabled but the picker options
    // remain mounted (component state `snoozeOpen` is preserved across
    // re-renders). The trigger cannot be opened from the disabled
    // state, so the open-then-flip pattern is the only path that
    // surfaces the option's disabled treatment.
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
          onRemediate={() => {}}
          onClear={() => {}}
        />,
      );
    });
    await click(container.querySelector('[data-testid="bulk-snooze-picker-cta"]'));
    expect(queryDoc('[data-testid="bulk-snooze-pick-1d"]')).not.toBeNull();
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
          onRemediate={() => {}}
          onClear={() => {}}
        />,
      );
    });
    for (const id of [
      'bulk-snooze-picker-cta',
      'bulk-snooze-pick-1d',
      'bulk-snooze-pick-3d',
      'bulk-snooze-pick-7d',
      'bulk-snooze-pick-30d',
      'bulk-remediate-cta',
      'bulk-reopen-cta',
      'bulk-false-positive-cta',
      'bulk-resolve-cta',
    ]) {
      // Options live in a portalled subtree; reach into document for
      // the matching element so the assertion tolerates the portal.
      const btn = id.startsWith('bulk-snooze-pick-')
        ? queryDoc(`[data-testid="${id}"]`)
        : container.querySelector(`[data-testid="${id}"]`);
      expect(btn?.hasAttribute('disabled')).toBe(true);
    }
  });

  it('renders the "Remediating…" pending label while the fan-out is in flight', async () => {
    const host = await renderBar({
      selectionCount: 2,
      results: new Map(),
      pending: true,
      onResolve: () => {},
      onReopenSelected: () => {},
      onMarkFalsePositive: () => {},
      onSnooze: () => {},
      onRemediate: () => {},
      onClear: () => {},
    });
    const text = (host.textContent ?? '').toLowerCase();
    // The pending-state Loader2 + "Remediating…" pattern matches
    // the existing Snooze / Reopen / Resolve CTA postures.
    expect(text).toContain('remediating');
  });
});
