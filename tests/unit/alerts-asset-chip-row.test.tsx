// Pure rendering smoke test for the asset filter chip row. Locks
// the chip contract:
//   - One chip per option, labeled with the composite `${host}
//     :${port}/${protocol}` name and a small numeric suffix badge.
//   - Active chips (multi-select Set membership) carry
//     aria-pressed=true + data-active=true.
//   - Inactive chips carry aria-pressed=false.
//   - Click on any chip toggles its membership in the next Set; when
//     the Set becomes empty, onChange fires with `null` so the page's
//     `effectiveQs` writer drops the `?asset=` key.
//   - When more options exist than `maxItems`, an aria-disabled
//     informational "+N more" pill renders OUTSIDE the active set; its
//     click is a no-op (no onChange fires).
//   - When the Set is non-empty, an extra ghost-variant button labelled
//     "Clear" is rendered; clicking it fires onChange(null).
//   - Re-clicking the already-active chip REMOVES it from the Set.
//
// Renders through React's createRoot into jsdom; no DB, no apiFetch, no
// router — the chip is pure presentational + a controlled callback.
// Every render + click wraps in `await act(...)` so React 19's
// concurrent scheduler has actually flushed before the queries run.

// React 19 refuses `act(...)` unless the current test environment
// explicitly opts in via this flag — without setting it here the call
// emits a stderr warning AND silently flushes only some tree siblings,
// which is what makes concurrent-row assertions flake. Set it before
// any React import to keep the act wrapper honest.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import {
  AlertsAssetChipRow,
  type AssetFilterOption,
} from '@/components/dashboard/alerts-asset-chip-row';

const OPTS: AssetFilterOption[] = [
  { name: 'example.com:443/tcp', count: 3 },
  { name: 'vpn.example.com:80/udp', count: 7 },
  { name: 'api.example.com:8080/tcp', count: 1 },
];

// Stateful test wrapper that mirrors the page-level React state shape
// (useState<Set<string> | null>) so subsequent clicks see the updated
// Set without a manual re-render. Each test renders this wrapper,
// clicks chips, then asserts on the recorded props.
function StatefulHarness({
  initial,
  onChangeCalls,
  options,
  maxItems,
}: {
  initial: Set<string> | null;
  onChangeCalls: Array<Set<string> | null>;
  options: AssetFilterOption[];
  maxItems?: number;
}) {
  const [value, setValue] = useState<Set<string> | null>(initial);
  return (
    <AlertsAssetChipRow
      value={value}
      onChange={(next) => {
        onChangeCalls.push(next);
        setValue(next);
      }}
      options={options}
      maxItems={maxItems}
    />
  );
}

// Identify the toggle chips: any button whose textContent includes
// the composite `host:port/protocol` separator (`:port/`) — excludes
// the overflow pill and the trailing Clear button.
function chipButtons(host: HTMLElement): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll('button')).filter((b) =>
    /:\d+\//.test(b.textContent ?? ''),
  );
}

function overflowPill(host: HTMLElement): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll('button')).find((b) =>
    /\+\d+ more/.test(b.textContent ?? ''),
  );
}

function clearButton(host: HTMLElement): HTMLButtonElement | undefined {
  // The trailing ghost-variant button — same shape as the severity
  // chip row. Its textContent is `Clear`, preceded by the lucide X
  // icon's empty space. match by literal ``Clear``.
  return Array.from(host.querySelectorAll('button')).find(
    (b) => b.getAttribute('aria-label') === 'Clear asset filter',
  );
}

async function clickChip(button: HTMLButtonElement | null | undefined) {
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function mount(ui: (calls: Array<Set<string> | null>) => React.ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const calls: Array<Set<string> | null> = [];
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

describe('AlertsAssetChipRow', () => {
  it('renders one chip per option inside a labeled fieldset', async () => {
    const { container, root } = await mount(() => (
      <AlertsAssetChipRow value={null} onChange={() => {}} options={OPTS} />
    ));
    try {
      const fieldset = container.querySelector('fieldset');
      expect(fieldset).not.toBeNull();
      expect(fieldset?.getAttribute('aria-label')).toBe('Filter alerts by asset');
      const chips = chipButtons(container);
      expect(chips.map((c) => c.textContent?.trim())).toEqual([
        'example.com:443/tcp 3',
        'vpn.example.com:80/udp 7',
        'api.example.com:8080/tcp 1',
      ]);
    } finally {
      await unmount(root, container);
    }
  });

  it('marks only active chips with aria-pressed=true / data-active=true', async () => {
    const { container, root } = await mount(() => (
      <AlertsAssetChipRow
        value={new Set(['example.com:443/tcp', 'api.example.com:8080/tcp'])}
        onChange={() => {}}
        options={OPTS}
      />
    ));
    try {
      const chips = chipButtons(container);
      expect(chips.map((c) => c.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'true']);
      expect(chips.map((c) => c.getAttribute('data-active'))).toEqual(['true', 'false', 'true']);
      expect(chips[0]?.className).toContain('bg-primary');
      expect(chips[2]?.className).toContain('bg-primary');
      expect(chips[1]?.className).not.toContain('bg-primary');
    } finally {
      await unmount(root, container);
    }
  });

  it('reports empty state when value is null', async () => {
    const { container, root } = await mount(() => (
      <AlertsAssetChipRow value={null} onChange={() => {}} options={OPTS} />
    ));
    try {
      const chips = chipButtons(container);
      expect(chips.map((c) => c.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false']);
      expect(chips[0]?.className).not.toContain('bg-primary');
    } finally {
      await unmount(root, container);
    }
  });

  it('keeps long hostname chips within narrow containers while exposing the full asset label', async () => {
    const name = `${'very-long-subdomain.'.repeat(8)}example.test:443/tcp`;
    const { container, root } = await mount(() => (
      <AlertsAssetChipRow
        value={null}
        onChange={() => {}}
        options={[{ name, count: 2 }]}
      />
    ));
    try {
      const fieldset = container.querySelector('fieldset[aria-label="Filter alerts by asset"]');
      expect(fieldset?.className).toContain('min-w-0');
      expect(fieldset?.className).toContain('max-w-[calc(100vw-2rem)]');

      const chip = chipButtons(container)[0];
      expect(chip?.className).toContain('min-w-0');
      expect(chip?.getAttribute('aria-label')).toBe(`${name}, 2 alerts`);
      expect(chip?.querySelector('span')?.className).toContain('truncate');
    } finally {
      await unmount(root, container);
    }
  });

  it('does not render the clear button when value is null', async () => {
    const { container, root } = await mount(() => (
      <AlertsAssetChipRow value={null} onChange={() => {}} options={OPTS} />
    ));
    try {
      expect(clearButton(container)).toBeUndefined();
    } finally {
      await unmount(root, container);
    }
  });

  it('renders the clear button when at least one chip is active', async () => {
    const { container, root } = await mount(() => (
      <AlertsAssetChipRow
        value={new Set(['example.com:443/tcp'])}
        onChange={() => {}}
        options={OPTS}
      />
    ));
    try {
      const cb = clearButton(container);
      expect(cb).not.toBeUndefined();
      expect(cb?.getAttribute('aria-label')).toBe('Clear asset filter');
      expect(cb?.className).toContain('hover:bg-accent');
    } finally {
      await unmount(root, container);
    }
  });

  it('toggles chips into a Set on click, calling onChange with the new Set', async () => {
    const { container, root, calls } = await mount((c) => (
      <StatefulHarness initial={null} onChangeCalls={c} options={OPTS} />
    ));
    try {
      const chips = chipButtons(container);
      await clickChip(chips[0]); // → {example.com:443/tcp}
      await clickChip(chips[1]); // → {example.com:443/tcp, vpn.example.com:80/udp}
      expect(calls.length).toBe(2);
      expect(Array.from((calls[0] ?? new Set()).values())).toEqual(['example.com:443/tcp']);
      expect(Array.from((calls[1] ?? new Set()).values()).sort()).toEqual([
        'example.com:443/tcp',
        'vpn.example.com:80/udp',
      ]);
    } finally {
      await unmount(root, container);
    }
  });

  it('removes a chip from the active Set on a second click', async () => {
    const { container, root, calls } = await mount((c) => (
      <StatefulHarness
        initial={new Set(['example.com:443/tcp', 'api.example.com:8080/tcp'])}
        onChangeCalls={c}
        options={OPTS}
      />
    ));
    try {
      const chips = chipButtons(container);
      await clickChip(chips[0]); // → toggled off
      expect(calls.length).toBe(1);
      const next = calls[0];
      expect(next).not.toBeNull();
      expect(Array.from(next?.values() ?? []).sort()).toEqual(['api.example.com:8080/tcp']);
    } finally {
      await unmount(root, container);
    }
  });

  it('fires onChange(null) when the last chip is toggled off', async () => {
    const { container, root, calls } = await mount((c) => (
      <StatefulHarness
        initial={new Set(['example.com:443/tcp'])}
        onChangeCalls={c}
        options={OPTS}
      />
    ));
    try {
      const chips = chipButtons(container);
      await clickChip(chips[0]); // → null
      expect(calls).toEqual([null]);
    } finally {
      await unmount(root, container);
    }
  });

  it('clicking Clear fires onChange(null)', async () => {
    const { container, root, calls } = await mount((c) => (
      <StatefulHarness
        initial={new Set(['example.com:443/tcp', 'vpn.example.com:80/udp'])}
        onChangeCalls={c}
        options={OPTS}
      />
    ));
    try {
      const cb = clearButton(container);
      expect(cb).not.toBeUndefined();
      await clickChip(cb);
      expect(calls).toEqual([null]);
    } finally {
      await unmount(root, container);
    }
  });

  it('does NOT render the overflow pill when options fit under maxItems', async () => {
    const { container, root } = await mount(() => (
      <AlertsAssetChipRow value={null} onChange={() => {}} options={OPTS} maxItems={10} />
    ));
    try {
      expect(overflowPill(container)).toBeUndefined();
    } finally {
      await unmount(root, container);
    }
  });

  it('renders the overflow pill when options exceed maxItems (aria-disabled)', async () => {
    const manyOpts = Array.from({ length: 12 }, (_, i) => ({
      name: `host${i}.example.com:443/tcp`,
      count: i + 1,
    }));
    const { container, root } = await mount(() => (
      <AlertsAssetChipRow value={null} onChange={() => {}} options={manyOpts} maxItems={10} />
    ));
    try {
      const pills = Array.from(container.querySelectorAll('button')).filter((b) =>
        /^\+\d+ more$/.test((b.textContent ?? '').trim()),
      );
      expect(pills).toHaveLength(1);
      const pill = pills[0];
      expect(pill?.getAttribute('aria-disabled')).toBe('true');
      expect(pill?.getAttribute('data-overflow')).toBe('true');
      expect(pill?.getAttribute('tabindex')).toBe('-1');
      expect(pill?.textContent?.trim()).toBe('+2 more');
    } finally {
      await unmount(root, container);
    }
  });

  it('clicking the overflow pill fires no onChange (no-op)', async () => {
    const manyOpts = Array.from({ length: 12 }, (_, i) => ({
      name: `host${i}.example.com:443/tcp`,
      count: i + 1,
    }));
    const { container, root, calls } = await mount((c) => (
      <StatefulHarness initial={null} onChangeCalls={c} options={manyOpts} maxItems={10} />
    ));
    try {
      const pill = overflowPill(container);
      expect(pill).not.toBeUndefined();
      await clickChip(pill);
      expect(calls.length).toBe(0);
    } finally {
      await unmount(root, container);
    }
  });
});
