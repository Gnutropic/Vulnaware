// Pure rendering smoke test for the severity filter chip row. Locks
// the chip contract:
//   - 5 chips rendered in a labeled fieldset (All / Critical / High / Medium / Low)
//   - value is a `Set<SeverityLiteral> | null` (multi-select posture).
//     `null` lights up the "All" chip; a populated Set lights up every
//     member-chip and keeps "All" inactive.
//   - active tier chips carry aria-pressed=true + data-active=true and
//     paint `chip.token.chipActive` (the per-severity color band from
//     `@/lib/ui/severity-colors`) so the row reads as the same color-
//     coded band as the row badges and the dashboard tile.
//   - the "All" chip paints the brand color when active; it is the
//     resting-state indicator — clicking it fires onChange(null)
//     regardless of incoming Set membership.
//   - clicking a tier chip toggles its membership in the next Set;
//     when the Set becomes empty, onChange fires with `null` so the
//     page's `effectiveQs` writer strips the `?severity=` key.
//   - no trailing ghost "Clear" button is rendered; "All" replaces
//     the role the Clear button used to play (a chip click on "All"
//     clears by virtue of firing `onChange(null)`).
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

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { AlertsSeverityChipRow } from '@/components/dashboard/alerts-severity-chip-row';
import type { SeverityLiteral } from '@/lib/business/alerts-severity';

const STANDARD_OPTIONS = ['critical', 'high', 'medium', 'low'] as const;

// Stateful test wrapper that mirrors the page-level React state shape
// (`useState<Set<SeverityLiteral> | null>`) so subsequent clicks see
// the updated value without a manual re-render. Each test renders this
// wrapper, clicks chips, then asserts on the recorded props.
function StatefulHarness({
  initial,
  onChangeCalls,
}: {
  initial: Set<SeverityLiteral> | null;
  onChangeCalls: Array<Set<SeverityLiteral> | null>;
}) {
  const [value, setValue] = useState<Set<SeverityLiteral> | null>(initial);
  return (
    <AlertsSeverityChipRow
      value={value}
      onChange={(next) => {
        onChangeCalls.push(next);
        setValue(next);
      }}
      options={STANDARD_OPTIONS}
    />
  );
}

function chipButtons(host: HTMLElement): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll('button'));
}

async function clickChip(button: HTMLButtonElement | null | undefined) {
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function mount(ui: (calls: Array<Set<SeverityLiteral> | null>) => React.ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const calls: Array<Set<SeverityLiteral> | null> = [];
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(ui(calls));
  });
  return { container, root, calls };
}

async function unmount(root: Root, container: HTMLDivElement) {
  await act(async () => {
    root.unmount();
  });
  if (container.parentNode) container.parentNode.removeChild(container);
}

describe('AlertsSeverityChipRow', () => {
  it('renders five severity chips inside a labeled fieldset', async () => {
    const { container, root } = await mount(() => (
      <AlertsSeverityChipRow value={null} onChange={() => {}} options={STANDARD_OPTIONS} />
    ));
    try {
      const fieldset = container.querySelector('fieldset');
      expect(fieldset).not.toBeNull();
      expect(fieldset?.getAttribute('aria-label')).toBe('Filter alerts by severity');
      const chips = chipButtons(container);
      expect(chips.map((c) => c.textContent?.trim())).toEqual([
        'All',
        'Critical',
        'High',
        'Medium',
        'Low',
      ]);
    } finally {
      await unmount(root, container);
    }
  });

  it('renders server-provided custom options with a neutral token and humanized label', async () => {
    const { container, root, calls } = await mount((recorded) => (
      <AlertsSeverityChipRow
        value={new Set<SeverityLiteral>(['legacy-value'])}
        onChange={(next) => recorded.push(next)}
        options={['critical', 'legacy-value']}
      />
    ));
    try {
      const chips = chipButtons(container);
      expect(chips.map((chip) => chip.textContent?.trim())).toEqual(['All', 'Critical', 'Legacy Value']);
      expect(chips[2]?.getAttribute('aria-pressed')).toBe('true');
      expect(chips[2]?.className).toContain('bg-muted');
      await clickChip(chips[2]);
      expect(calls).toEqual([null]);
    } finally {
      await unmount(root, container);
    }
  });

  it('lights BOTH member chips when the Set has two entries (aria-pressed=true + data-active=true)', async () => {
    // Multi-select: a `Set{critical, high}` lights Critical + High
    // chips; "All" + Medium + Low stay inactive. The aria + data
    // attributes carry the screen-reader / e2e state.
    const { container, root } = await mount(() => (
      <AlertsSeverityChipRow
        value={new Set<SeverityLiteral>(['critical', 'high'])}
        onChange={() => {}}
        options={STANDARD_OPTIONS}
      />
    ));
    try {
      const chips = chipButtons(container);
      // Order: All, Critical, High, Medium, Low
      expect(chips.map((c) => c.getAttribute('aria-pressed'))).toEqual([
        'false',
        'true',
        'true',
        'false',
        'false',
      ]);
      expect(chips.map((c) => c.getAttribute('data-active'))).toEqual([
        'false',
        'true',
        'true',
        'false',
        'false',
      ]);
    } finally {
      await unmount(root, container);
    }
  });

  it('paints per-severity color when ONE tier chip is active', async () => {
    // Brief invariant: the active chip's color band matches the row
    // badge + the dashboard tile. The class fragment is the
    // `chip.token.chipActive` substring from
    // `@/lib/ui/severity-colors`. Pin per-severity here so a future
    // refactor that swaps in `bg-primary` (the asset-chip posture)
    // breaks the consistency invariant.
    const cases: ReadonlyArray<{
      active: SeverityLiteral;
      fragment: string;
    }> = [
      { active: 'critical', fragment: 'bg-destructive' },
      { active: 'high', fragment: 'bg-destructive/85' },
      { active: 'medium', fragment: 'bg-amber-500' },
      { active: 'low', fragment: 'bg-blue-500' },
    ];
    for (const c of cases) {
      const { container, root } = await mount(() => (
        <AlertsSeverityChipRow
          value={new Set<SeverityLiteral>([c.active])}
          onChange={() => {}}
          options={STANDARD_OPTIONS}
        />
      ));
      try {
        const chips = chipButtons(container);
        // Order: All, Critical, High, Medium, Low — index of the
        // active chip is offset by 1.
        const idx =
          c.active === 'critical' ? 1 : c.active === 'high' ? 2 : c.active === 'medium' ? 3 : 4;
        expect(chips[idx]?.className).toContain(c.fragment);
        // Negative: the brand-tone All chip is inactive here.
        expect(chips[0]?.className).not.toContain('bg-brand-600');
        // Negative: NO tier chip should paint `bg-primary` (the
        // asset-row brand-default); the per-severity color is the
        // brief's lockstep invariant.
        for (const chip of chips) {
          expect(chip.className).not.toContain('bg-primary');
        }
      } finally {
        await unmount(root, container);
      }
    }
  });

  it('reports "All" as the active chip — with the brand band — when value is null', async () => {
    // The resting state: no tier chips active, "All" chip paints
    // the brand `chipActive` fragment from
    // `ALL_SEVERITY_COLOR_TOKEN.chipActive` and reads
    // aria-pressed=true. The brand color is what makes "All" stand
    // apart from the per-severity band.
    const { container, root } = await mount(() => (
      <AlertsSeverityChipRow value={null} onChange={() => {}} options={STANDARD_OPTIONS} />
    ));
    try {
      const chips = chipButtons(container);
      expect(chips.map((c) => c.getAttribute('aria-pressed'))).toEqual([
        'true',
        'false',
        'false',
        'false',
        'false',
      ]);
      expect(chips[0]?.className).toContain('bg-brand-600');
      // Negative: none of the tier chips paint a per-severity or
      // brand band.
      for (let i = 1; i < chips.length; i++) {
        expect(chips[i]?.className).not.toContain('bg-brand-600');
        expect(chips[i]?.className).not.toContain('bg-destructive');
        expect(chips[i]?.className).not.toContain('bg-amber-500');
        expect(chips[i]?.className).not.toContain('bg-blue-500');
      }
    } finally {
      await unmount(root, container);
    }
  });

  it('does not render a Clear button (the "All" chip is the resting-state indicator)', async () => {
    const { container, root } = await mount(() => (
      <AlertsSeverityChipRow
        value={new Set<SeverityLiteral>(['critical'])}
        onChange={() => {}}
        options={STANDARD_OPTIONS}
      />
    ));
    try {
      const clear = chipButtons(container).find((b) => b.textContent?.trim() === 'Clear');
      expect(clear).toBeUndefined();
    } finally {
      await unmount(root, container);
    }
  });

  it('clicking an inactive tier chip fires onChange with a 1-element Set (toggle-in)', async () => {
    const { container, root, calls } = await mount((c) => (
      <StatefulHarness initial={null} onChangeCalls={c} />
    ));
    try {
      const chips = chipButtons(container);
      await clickChip(chips[1]); // Critical
      expect(calls.length).toBe(1);
      const next = calls[0];
      expect(next).not.toBeNull();
      expect(Array.from(next?.values() ?? [])).toEqual(['critical']);
    } finally {
      await unmount(root, container);
    }
  });

  it('clicking an active tier chip removes it from the next Set (toggle-out)', async () => {
    const { container, root, calls } = await mount((c) => (
      <StatefulHarness initial={new Set<SeverityLiteral>(['critical', 'high'])} onChangeCalls={c} />
    ));
    try {
      const chips = chipButtons(container);
      await clickChip(chips[1]); // Critical — already active, should toggle off
      expect(calls.length).toBe(1);
      const next = calls[0];
      expect(next).not.toBeNull();
      expect(Array.from(next?.values() ?? []).sort()).toEqual(['high']);
    } finally {
      await unmount(root, container);
    }
  });

  it('clicking the last active tier fires onChange(null) (empty Set collapses to null)', async () => {
    // The writer treats an empty Set the same as null — so the chip
    // row emits `null` (NOT an empty Set) when the last tier flips
    // off. This is the "Clear via chip click" wire shape.
    const { container, root, calls } = await mount((c) => (
      <StatefulHarness initial={new Set<SeverityLiteral>(['high'])} onChangeCalls={c} />
    ));
    try {
      const chips = chipButtons(container);
      await clickChip(chips[2]); // High — already active, last one out
      expect(calls).toEqual([null]);
    } finally {
      await unmount(root, container);
    }
  });

  it('clicking the All chip fires onChange(null) regardless of incoming Set membership', async () => {
    // The "All" chip is THE clear gesture: one click from any
    // populated Set lands at `null` (the resting state). Same
    // posture from the resting state — clicking "All" with a `null`
    // incoming value fires `onChange(null)` (no-op visually but
    // still a write that re-affirms the resting state).
    const { container, root, calls } = await mount((c) => (
      <StatefulHarness
        initial={new Set<SeverityLiteral>(['critical', 'high', 'medium'])}
        onChangeCalls={c}
      />
    ));
    try {
      const chips = chipButtons(container);
      await clickChip(chips[0]); // All
      expect(calls).toEqual([null]);
    } finally {
      await unmount(root, container);
    }
  });
});
