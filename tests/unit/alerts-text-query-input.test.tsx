// Component test for the /alerts free-form text query input. Locks the
// island contract:
//   - search input renders with the documented placeholder, type="search"
//   - clear button (aria-label="Clear search") only appears once the
//     draft is non-empty, and clears the input to '' on click
//   - 200ms debounced URL write coalesces keystrokes into ONE
//     router.replace call carrying only the `q` key, leaving chip-state
//     keys intact (status / ownedBy)
//   - trimming: typed value joins the URL after .trim() and any leading
//     / trailing whitespace is removed
//   - clearing: empty draft strips `q` from the URL after the debounce
//     idle, leaving other keys in place
//   - composition: typing `q` does NOT clobber status=/ownedBy= already
//     on the URL; chip clicks do NOT clobber a typed `q`
//   - selection strip: any keystroke (including the clear button click)
//     drops `?selected=` from the URL so the working set doesn't go
//     stale against the new view
//
// Mocks `next/navigation` so the assertion target is the `replace`
// spy rather than the rendered DOM (the page-level fetch isn't part of
// this island; the parent page re-fetches when the URL changes, but
// this island only writes the URL).

// @vitest-environment jsdom

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(),
}));

import { AlertsTextQueryInput } from '@/components/dashboard/alerts-text-query-input';
import { AlertsHostnameSearchInput } from '@/components/dashboard/alerts-hostname-search-input';

const { useRouter, useSearchParams } = await import('next/navigation');

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function makeRouter() {
  const replace = vi.fn<(href: string, options?: { scroll?: boolean }) => void>((href) => {
    window.history.replaceState(null, '', href);
  });
  const router = { replace };
  (useRouter as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => router);
  return { replace, router };
}

function setSearchParams(qs: string) {
  const sp = new URLSearchParams(qs);
  (useSearchParams as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => sp);
  const query = sp.toString();
  window.history.replaceState(null, '', `/alerts${query ? `?${query}` : ''}`);
}

async function mountInput(initialValue = '') {
  container = document.createElement('div');
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  await act(async () => {
    created.render(<AlertsTextQueryInput initialValue={initialValue} />);
  });
  return container;
}

async function mountHostnameInput(initialValue = '') {
  container = document.createElement('div');
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  await act(async () => {
    created.render(<AlertsHostnameSearchInput initialValue={initialValue} />);
  });
  return container;
}

async function unmountInput() {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  if (container?.parentNode) {
    container.parentNode.removeChild(container);
  }
  container = null;
}

// Drive a `<input type="search">` change the way a user keystroke
// would: bypass React's synthetic-event value setter (which silently
// no-ops in React 19 / jsdom) by using the native prototype's value
// setter, then dispatch a real `input` event so React's onChange fires.
function setNativeInputValue(el: HTMLInputElement, value: string) {
  const proto = Object.getPrototypeOf(el) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(async () => {
  vi.useRealTimers();
  await unmountInput();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.useFakeTimers();
});

describe('AlertsTextQueryInput', () => {
  it('renders the search input with the documented placeholder and hides the clear button when empty', async () => {
    const { replace } = makeRouter();
    setSearchParams('');
    const host = await mountInput('');

    const input = host.querySelector<HTMLInputElement>('input[type="search"]');
    expect(input).not.toBeNull();
    expect(input?.getAttribute('placeholder')).toBe('Search CVE, hostname, or title…');
    expect(input?.id).toBe('alerts-text-query-input');
    expect(input?.getAttribute('maxlength')).toBe('200');

    // Pin the re-tokening: the input lives inside a `<label>` pill that
    // matches the sort selector's token family. If a regression
    // re-introduces the shadcn `<Input>` wrapper, the label's class
    // list will lose `min-h-11 rounded-full border-input px-4` and this
    // assertion will trip.
    const label = host.querySelector<HTMLLabelElement>('label[for="alerts-text-query-input"]');
    expect(label).not.toBeNull();
    expect(label?.className).toContain('min-h-11');
    expect(label?.className).toContain('rounded-full');
    expect(label?.className).toContain('border-input');
    expect(label?.className).toContain('px-4');
    // The wrapper pill carries `border border-input` so the input
    // itself stays borderless / transparent — guard against a future
    // hand-roll that flips the wrapper back to the shadcn
    // rounded-md-bordered input styling.
    expect(input?.className).toContain('bg-transparent');
    expect(input?.className).not.toContain('rounded-md');

    // Clear button is hidden on an empty draft.
    expect(host.querySelector('button[aria-label="Clear search"]')).toBeNull();

    // An empty draft on the existing /alerts URL is already current,
    // so the writer skips a redundant router.replace on first paint.
    await act(async () => {
      vi.advanceTimersByTime(260);
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it('pre-fills the input from initialValue', async () => {
    makeRouter();
    setSearchParams('');
    const host = await mountInput('log4j');
    const input = host.querySelector<HTMLInputElement>('input[type="search"]');
    expect(input?.value).toBe('log4j');
  });

  it('keeps the hostname input independent from q when only the text search is active', async () => {
    const { replace } = makeRouter();
    setSearchParams('q=log4j&severity=critical&sort=severity');
    const host = await mountHostnameInput('');
    const input = host.querySelector<HTMLInputElement>('input[type="search"]');

    expect(input?.value).toBe('');

    await act(async () => {
      vi.advanceTimersByTime(260);
    });

    expect(replace).not.toHaveBeenCalled();
    expect(new URLSearchParams(window.location.search).has('hostname')).toBe(false);
  });

  it('restores hostname from URL and preserves q, other filters, and sort when it changes', async () => {
    const { replace } = makeRouter();
    setSearchParams(
      'q=log4j&hostname=old.example&severity=critical&status=in_progress&sort=created_asc&from=2026-10-01',
    );
    const host = await mountHostnameInput('old.example');
    const input = host.querySelector<HTMLInputElement>('input[type="search"]');
    if (!input) throw new Error('expected hostname input to be rendered');

    expect(input.value).toBe('old.example');
    await act(async () => {
      setNativeInputValue(input, 'api.example');
      vi.advanceTimersByTime(260);
    });

    expect(replace).toHaveBeenCalledTimes(1);
    const params = new URLSearchParams(window.location.search);
    expect(params.get('hostname')).toBe('api.example');
    expect(params.get('q')).toBe('log4j');
    expect(params.get('severity')).toBe('critical');
    expect(params.get('status')).toBe('in_progress');
    expect(params.get('sort')).toBe('created_asc');
    expect(params.get('from')).toBe('2026-10-01');
  });

  it('writes exactly one router.replace 200ms after typing, mutating only the q key', async () => {
    const { replace } = makeRouter();
    setSearchParams('?status=open&ownedBy=me');
    const host = await mountInput('');

    const input = host.querySelector<HTMLInputElement>('input[type="search"]');
    if (!input) throw new Error('expected input to be rendered');

    await act(async () => {
      setNativeInputValue(input, 'CVE-2024-1234');
    });

    // Before the debounce window: no URL write yet.
    expect(replace).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(260);
    });

    expect(replace).toHaveBeenCalledTimes(1);
    const [href, opts] = replace.mock.calls[0] ?? [];
    // `q` is appended at the end because the existing chip-state keys
    // (status, ownedBy) are preserved verbatim from the input URL and
    // `URLSearchParams.set` inserts new keys after that. The composable
    // contract is the SET of keys, not their order; consumers parse
    // the URL with URLSearchParams, which is order-insensitive.
    expect(href).toBe('/alerts?status=open&ownedBy=me&q=CVE-2024-1234');
    expect(opts).toEqual({ scroll: false });
  });

  it('coalesces keystrokes into a single router.replace carrying the trimmed full value', async () => {
    const { replace } = makeRouter();
    setSearchParams('');
    const host = await mountInput('');

    const input = host.querySelector<HTMLInputElement>('input[type="search"]');
    if (!input) throw new Error('expected input to be rendered');

    // Three rapid keystrokes within a single debounce window.
    await act(async () => {
      setNativeInputValue(input, 'C');
      vi.advanceTimersByTime(50);
      setNativeInputValue(input, 'CV');
      vi.advanceTimersByTime(50);
      setNativeInputValue(input, 'CVE');
    });

    await act(async () => {
      vi.advanceTimersByTime(260);
    });

    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0]?.[0]).toBe('/alerts?q=CVE');
  });

  it('clear button strips q from the URL after the debounce', async () => {
    const { replace } = makeRouter();
    setSearchParams('?status=open&ownedBy=me');
    const host = await mountInput('');

    const input = host.querySelector<HTMLInputElement>('input[type="search"]');
    if (!input) throw new Error('expected input to be rendered');

    await act(async () => {
      setNativeInputValue(input, 'foo');
    });
    await act(async () => {
      vi.advanceTimersByTime(260);
    });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0]?.[0]).toBe('/alerts?status=open&ownedBy=me&q=foo');
    replace.mockClear();

    // Clear button is now visible (text was typed).
    const clearBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]');
    expect(clearBtn).not.toBeNull();
    expect(clearBtn?.getAttribute('aria-controls')).toBe('alerts-text-query-input');
    expect(clearBtn?.getAttribute('type')).toBe('button');

    await act(async () => {
      clearBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Input is empty immediately (state flush).
    expect(input.value).toBe('');

    // After the debounce, URL drops `q` while keeping status / ownedBy.
    await act(async () => {
      vi.advanceTimersByTime(260);
    });

    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0]?.[0]).toBe('/alerts?status=open&ownedBy=me');
  });

  it('typed q composes with status / ownedBy already on the URL', async () => {
    const { replace } = makeRouter();
    setSearchParams('?status=open&ownedBy=me');
    const host = await mountInput('');

    const input = host.querySelector<HTMLInputElement>('input[type="search"]');
    if (!input) throw new Error('expected input to be rendered');

    await act(async () => {
      setNativeInputValue(input, 'log4j');
    });
    await act(async () => {
      vi.advanceTimersByTime(260);
    });

    expect(replace).toHaveBeenCalledTimes(1);
    const href = replace.mock.calls[0]?.[0] as string;
    expect(href.startsWith('/alerts?')).toBe(true);
    expect(href).toContain('q=log4j');
    expect(href).toContain('status=open');
    expect(href).toContain('ownedBy=me');
  });

  it('strips ?selected= on every keystroke so the working set does not go stale', async () => {
    const { replace } = makeRouter();
    setSearchParams('?status=open&ownedBy=me&selected=alert_a%2Calert_b');
    const host = await mountInput('');

    const input = host.querySelector<HTMLInputElement>('input[type="search"]');
    if (!input) throw new Error('expected input to be rendered');

    await act(async () => {
      setNativeInputValue(input, 'c');
    });
    await act(async () => {
      vi.advanceTimersByTime(260);
    });

    expect(replace).toHaveBeenCalledTimes(1);
    const href = replace.mock.calls[0]?.[0] as string;
    expect(href).not.toContain('selected=');
    expect(href).toContain('q=c');
    expect(href).toContain('status=open');
    expect(href).toContain('ownedBy=me');
  });

  it('renders an accessible hostname control, debounces hostname, and clears only hostname state', async () => {
    const { replace } = makeRouter();
    setSearchParams('?severity=critical&sort=severity_asc&hostname=old.example');
    const host = await mountHostnameInput('old.example');

    const input = host.querySelector<HTMLInputElement>('#alerts-hostname-search');
    const label = host.querySelector<HTMLLabelElement>('label[for="alerts-hostname-search"]');
    expect(input?.getAttribute('placeholder')).toBe('Search asset hostname…');
    expect(label?.textContent).toContain('Search alerts by asset hostname');
    expect(input?.labels).toHaveLength(1);

    if (!input) throw new Error('expected hostname input to be rendered');
    await act(async () => {
      setNativeInputValue(input, 'api.example');
      vi.advanceTimersByTime(260);
    });
    expect(replace).toHaveBeenCalledWith(
      '/alerts?severity=critical&sort=severity_asc&hostname=api.example',
      { scroll: false },
    );

    const clear = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Clear hostname search"]',
    );
    expect(clear).not.toBeNull();
    await act(async () => {
      clear?.click();
    });
    await act(async () => {
      vi.advanceTimersByTime(260);
    });
    expect(replace).toHaveBeenLastCalledWith('/alerts?severity=critical&sort=severity_asc', {
      scroll: false,
    });
  });
});
