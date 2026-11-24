// Component test for the /alerts active `q=` badge. Locks the island
// contract:
//   - empty / whitespace-only value → renders `null` (no chip-band slot)
//   - non-empty value → renders a chip-band-styled Button labeled
//     "Search: <trimmed q>" PLUS an inline ghost X Button with
//     aria-label="Clear search"
//   - main Button carries the chip-band fingerprint
//     (`min-h-11 rounded-full px-4 md:min-h-0 md:px-3`) so the badge
//     reads as part of the surrounding filter band
//   - X click strips `q` from the URL via `router.replace` and
//     preserves other URL keys (`status`, `ownedBy`)
//   - X click also strips `?selected=` so the bulk-resolve working
//     set doesn't go stale against a view change (mirrors the
//     page-level `viewKey` posture)
//
// Mocks `next/navigation` so the assertion target is the `replace`
// spy rather than the rendered DOM (the page-level fetch isn't part
// of this island; the parent page re-fetches when the URL changes).

// @vitest-environment jsdom

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(),
}));

import { AlertsSearchQueryBadge } from '@/components/dashboard/alerts-search-query-badge';

const { useRouter, useSearchParams } = await import('next/navigation');

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function makeRouter() {
  const replace = vi.fn();
  const router = { replace };
  (useRouter as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => router);
  return { replace, router };
}

function setSearchParams(qs: string) {
  const sp = new URLSearchParams(qs);
  (useSearchParams as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => sp);
}

async function mountBadge(value: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  await act(async () => {
    created.render(<AlertsSearchQueryBadge value={value} />);
  });
  return container;
}

async function unmountBadge() {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  if (container?.parentNode) {
    container.parentNode.removeChild(container);
  }
  container = null;
}

afterEach(async () => {
  await unmountBadge();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.useRealTimers();
});

describe('AlertsSearchQueryBadge', () => {
  it('renders null when value is empty', async () => {
    makeRouter();
    setSearchParams('');
    const host = await mountBadge('');
    // No fieldset, no buttons — null mount.
    expect(host.querySelector('fieldset')).toBeNull();
    expect(host.querySelectorAll('button').length).toBe(0);
  });

  it('renders null when value is whitespace-only', async () => {
    makeRouter();
    setSearchParams('');
    const host = await mountBadge('   ');
    expect(host.querySelector('fieldset')).toBeNull();
    expect(host.querySelectorAll('button').length).toBe(0);
  });

  it('renders a button with the trimmed q as its label when value is non-empty', async () => {
    makeRouter();
    setSearchParams('?q=foo');
    const host = await mountBadge('  log4j  ');

    const fieldset = host.querySelector('fieldset');
    expect(fieldset).not.toBeNull();
    expect(fieldset?.getAttribute('aria-label')).toBe('Active search query');
    expect(fieldset?.textContent).toContain('Search:');
    // The trimmed value lands in the label, not the raw padded value.
    expect(fieldset?.textContent).toContain('log4j');
    expect(fieldset?.textContent).not.toContain('  log4j  ');
  });

  it('renders an inline ghost X sibling with aria-label="Clear search"', async () => {
    makeRouter();
    setSearchParams('?q=foo');
    const host = await mountBadge('foo');
    const clearBtn = host.querySelector('button[aria-label="Clear search"]');
    expect(clearBtn).not.toBeNull();
    expect(clearBtn?.getAttribute('type')).toBe('button');
  });

  it('main Button carries the chip-band fingerprint', async () => {
    makeRouter();
    setSearchParams('');
    const host = await mountBadge('foo');
    // Find the fieldset's main button (the one carrying Search + label,
    // not the inline ghost X sibling).
    const mainBtn = Array.from(host.querySelectorAll('fieldset > button')).find(
      (b) => b.getAttribute('aria-label') == null,
    );
    expect(mainBtn).not.toBeUndefined();
    const cls = mainBtn?.getAttribute('class') ?? '';
    expect(cls).toContain('min-h-11');
    expect(cls).toContain('rounded-full');
    expect(cls).toContain('px-4');
    expect(cls).toContain('md:min-h-0');
    expect(cls).toContain('md:px-3');
    // Active-state aria + data attrs because the badge is always
    // active when value is non-empty.
    expect(mainBtn?.getAttribute('aria-pressed')).toBe('true');
    expect(mainBtn?.getAttribute('data-active')).toBe('true');
  });

  it('clicking the X strips q from the URL while preserving other keys', async () => {
    const { replace } = makeRouter();
    setSearchParams('?q=log4j&status=open&ownedByMe=1');
    const host = await mountBadge('log4j');

    const clearBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]');
    if (!clearBtn) throw new Error('expected clear button');

    await act(async () => {
      clearBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(replace).toHaveBeenCalledTimes(1);
    const [href, opts] = replace.mock.calls[0] ?? [];
    expect(href).toBe('/alerts?status=open&ownedByMe=1');
    expect(opts).toEqual({ scroll: false });
  });

  it('clicking the X also strips ?selected= so the working set does not go stale', async () => {
    const { replace } = makeRouter();
    setSearchParams('?q=foo&status=open&selected=alert_a%2Calert_b');
    const host = await mountBadge('foo');

    const clearBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]');
    if (!clearBtn) throw new Error('expected clear button');

    await act(async () => {
      clearBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(replace).toHaveBeenCalledTimes(1);
    const href = replace.mock.calls[0]?.[0] as string;
    expect(href).not.toContain('q=');
    expect(href).not.toContain('selected=');
    expect(href).toContain('status=open');
    expect(href.startsWith('/alerts?')).toBe(true);
  });

  it('clicking the X writes the bare "/alerts" when no other keys remain after stripping', async () => {
    const { replace } = makeRouter();
    setSearchParams('?q=foo');
    const host = await mountBadge('foo');

    const clearBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]');
    if (!clearBtn) throw new Error('expected clear button');

    await act(async () => {
      clearBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0]?.[0]).toBe('/alerts');
    expect(replace.mock.calls[0]?.[1]).toEqual({ scroll: false });
  });

  it('truncates long values to ≤ 60 chars in the visible label, full value preserved in title', async () => {
    makeRouter();
    setSearchParams('');
    const longValue = 'a'.repeat(80);
    const host = await mountBadge(longValue);

    const labelSpan = Array.from(host.querySelectorAll('span')).find(
      (s) => s.getAttribute('title') === longValue,
    );
    expect(labelSpan).not.toBeUndefined();
    expect(labelSpan?.textContent?.length).toBeLessThanOrEqual(60 + 1); // +1 for the trailing ellipsis
    expect(labelSpan?.textContent?.endsWith('…')).toBe(true);
    // Full value survives only on the title attr (hover-recovery path).
    expect(labelSpan?.getAttribute('title')).toBe(longValue);
  });
});
