// Pure rendering smoke test for the canned/cached "Suggest fix steps
// with AI" client island. Pins:
//
//   - The no-CVE branch renders a muted panel and DOES NOT render
//     the Suggest-fix-steps button (gate mirrors the route's
//     short-circuit on UNKNOWN).
//   - The cold-cache idle branch renders the click-to-generate
//     prompt and the button.
//   - A successful GET pre-fills the cached state and renders the
//     ordered <ol> with the saved step titles.
//   - A 503 POST lands the muted AI-temporarily-unavailable copy
//     on the panel.
//
// No DB, no apiFetch (we spy on globalThis.fetch). Each render +
// click wraps in `await act(...)` so React 19's concurrent
// scheduler has actually flushed before the queries run.
//
// React 19 refuses `act(...)` unless the current test environment
// explicitly opts in — set the flag before any React import.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SuggestFixStepsCard } from '@/components/dashboard/suggest-fix-steps-card';

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
  Reflect.deleteProperty(navigator, 'clipboard');
  vi.restoreAllMocks();
});

async function renderCard(props: {
  alertId: string;
  cveId: string;
  description?: string;
  asset: {
    id: string;
    host: string;
    ip: string;
    port: number;
    protocol: string;
    lastSeen: string | null;
  };
}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  await act(async () => {
    created.render(
      <SuggestFixStepsCard description={props.description ?? 'A synthetic vulnerability description.'} {...props} />,
    );
  });
  return container;
}

function buttonsByLabel(host: HTMLElement, prefix: string): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll('button')).filter((b) =>
    (b.textContent ?? '').trim().toLowerCase().startsWith(prefix.toLowerCase()),
  );
}

async function clickButton(button: HTMLButtonElement | null | undefined) {
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function flushAsync() {
  // Drain pending microtasks + a single macrotask so React's
  // concurrent scheduler has flushed any awaited useEffect bodies
  // (the GET-on-mount fetch + the POST click handler). Mirror of
  // the suggested-remediation test.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 16));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 16));
  });
}

const ASSET = {
  id: 'asset-1',
  host: 'edge.example.com',
  ip: '203.0.113.10',
  port: 443,
  protocol: 'tcp',
  lastSeen: '2026-07-01T12:00:00.000Z',
};

const STEPS = [
  {
    id: 'a'.repeat(16),
    title: 'Apply KB5034439',
    body: 'Patch via the OS vendor. Verify with: openssl version',
  },
  {
    id: 'b'.repeat(16),
    title: 'Validate SNI',
    body: 'curl --resolve against the affected host:port',
  },
  {
    id: 'c'.repeat(16),
    title: 'Re-scan',
    body: 'Trigger a fresh scheduled scan to confirm CVE clear',
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('SuggestFixStepsCard', () => {
  it('renders the no-CVE muted panel and HIDES the Suggest-fix-steps button when cveId is empty', async () => {
    const host = await renderCard({ alertId: 'alert-1', cveId: '', asset: ASSET });
    const noCve = host.querySelector('[data-testid="suggest-fix-steps-insufficient-context"]');
    expect(noCve).not.toBeNull();
    const text = host.textContent ?? '';
    expect(text).toContain('AI-generated advice');
    expect(text).toContain('Insufficient context');
    expect(buttonsByLabel(host, 'suggest fix steps with ai')[0]).toBeUndefined();
    expect(host.querySelector('[data-testid="suggest-fix-steps-button"]')).toBeNull();
  });

  it('renders the no-CVE muted panel when cveId is the literal UNKNOWN token', async () => {
    const host = await renderCard({ alertId: 'alert-1', cveId: 'UNKNOWN', asset: ASSET });
    expect(host.querySelector('[data-testid="suggest-fix-steps-insufficient-context"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="suggest-fix-steps-button"]')).toBeNull();
  });

  it('renders insufficient context when the vulnerability description is missing', async () => {
    const host = await renderCard({
      alertId: 'alert-1',
      cveId: 'CVE-2025-0001',
      description: '',
      asset: ASSET,
    });
    expect(host.querySelector('[data-testid="suggest-fix-steps-insufficient-context"]')).not.toBeNull();
    expect(host.textContent).toContain('vulnerability description');
    expect(host.querySelector('[data-testid="suggest-fix-steps-button"]')).toBeNull();
  });

  it('renders the click-to-generate prompt + button on an uncached alert', async () => {
    // Mock the GET-on-mount to return the cached-row miss envelope so
    // the island stays in idle (the useEffect parses the 200 + error
    // wire as a soft-fall, identical to a real cold cache).
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => jsonResponse({ error: 'unavailable' }));

    const host = await renderCard({ alertId: 'alert-1', cveId: 'CVE-2025-0001', asset: ASSET });
    await flushAsync();

    const button = host.querySelector(
      '[data-testid="suggest-fix-steps-button"]',
    ) as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    expect(button?.textContent?.toLowerCase()).toContain('suggest fix steps with ai');
    const text = host.textContent ?? '';
    expect(text).toContain('Click Suggest fix steps with AI');
    expect(text.toLowerCase()).toContain('cached per alert');

    // The GET-on-mount hit the cached route exactly once.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('/api/alerts/alert-1/suggested-fix');
    fetchSpy.mockRestore();
  });

  it('renders the cached-state ordered list on a successful GET', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () =>
      jsonResponse({
        alertId: 'alert-1',
        steps: STEPS,
        generatedAt: '2026-07-01T12:00:00.000Z',
        model: 'gpt-4o-mini',
      }),
    );

    const host = await renderCard({ alertId: 'alert-1', cveId: 'CVE-2025-0001', asset: ASSET });
    await flushAsync();

    const list = host.querySelector('[data-testid="suggest-fix-steps-list"]');
    expect(list).not.toBeNull();
    expect(list?.tagName.toLowerCase()).toBe('ol');
    const items = list?.querySelectorAll('li') ?? [];
    expect(items.length).toBe(STEPS.length);
    const joined = Array.from(items)
      .map((li) => li.textContent ?? '')
      .join('\n');
    expect(joined).toContain('Apply KB5034439');
    expect(joined).toContain('Validate SNI');
    expect(joined).toContain('Re-scan');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('/api/alerts/alert-1/suggested-fix');
    fetchSpy.mockRestore();
  });

  it('copies the displayed guidance bodies in order and confirms success', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () =>
      jsonResponse({
        alertId: 'alert-1',
        steps: STEPS,
        generatedAt: '2026-07-01T12:00:00.000Z',
        model: 'gpt-4o-mini',
      }),
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    const successToast = vi.spyOn(toast, 'success');

    const host = await renderCard({ alertId: 'alert-1', cveId: 'CVE-2025-0001', asset: ASSET });
    await flushAsync();

    const copyButton = host.querySelector(
      '[data-testid="suggest-fix-steps-copy-button"]',
    ) as HTMLButtonElement | null;
    expect(copyButton).not.toBeNull();
    await clickButton(copyButton);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(STEPS.map((step) => step.body).join('\n'));
    expect(successToast).toHaveBeenCalledWith('Guidance copied.');
  });

  it('keeps the guidance rendered and reports a clipboard failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () =>
      jsonResponse({
        alertId: 'alert-1',
        steps: STEPS,
        generatedAt: '2026-07-01T12:00:00.000Z',
        model: 'gpt-4o-mini',
      }),
    );
    const writeText = vi.fn().mockRejectedValue(new Error('Clipboard blocked'));
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    const errorToast = vi.spyOn(toast, 'error');

    const host = await renderCard({ alertId: 'alert-1', cveId: 'CVE-2025-0001', asset: ASSET });
    await flushAsync();

    const copyButton = host.querySelector(
      '[data-testid="suggest-fix-steps-copy-button"]',
    ) as HTMLButtonElement | null;
    expect(copyButton).not.toBeNull();
    await clickButton(copyButton);
    await flushAsync();

    expect(errorToast).toHaveBeenCalledWith('Could not copy remediation guidance.');
    expect(host.querySelector('[data-testid="suggest-fix-steps-list"]')).not.toBeNull();
    expect(host.textContent).toContain(STEPS[0]?.body);
    expect(host.textContent).toContain(STEPS[2]?.body);
  });

  it('renders the AI-temporarily-unavailable muted copy on a 503 POST', async () => {
    // GET-on-mount returns the unavailable envelope (cold cache so
    // the click prompt is the visible surface). Then a click POSTs;
    // the route returns 503 with the same unavailable body. apiFetch
    // throws on the 503, the island's catch branch sets state to
    // `unavailable`, and the muted copy surfaces at the
    // `suggest-fix-steps-fallback` test id.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => jsonResponse({ error: 'unavailable' }))
      .mockImplementationOnce(async () => jsonResponse({ error: 'unavailable' }, 503));

    const host = await renderCard({ alertId: 'alert-1', cveId: 'CVE-2025-0001', asset: ASSET });
    await flushAsync();

    const button = host.querySelector(
      '[data-testid="suggest-fix-steps-button"]',
    ) as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    await clickButton(button);
    await flushAsync();

    const fallback = host.querySelector('[data-testid="suggest-fix-steps-fallback"]');
    expect(fallback).not.toBeNull();
    const text = (fallback?.textContent ?? '').trim();
    expect(text).toContain('AI-generated advice is temporarily unavailable');
    expect(text).toContain('Click Suggest fix steps with AI to retry once the proxy is reachable');

    // GET-on-mount + click POST = 2 fetch calls. The POST hits the
    // same cached route (NOT the no-persist sibling); the click
    // tests the brief's regenerate path.
    const calls = fetchSpy.mock.calls;
    expect(calls.length).toBe(2);
    expect(String(calls[0]?.[0])).toBe('/api/alerts/alert-1/suggested-fix');
    expect(String(calls[1]?.[0])).toBe('/api/alerts/alert-1/suggested-fix');
    expect((calls[1]?.[1] as RequestInit | undefined)?.method).toBe('POST');
    fetchSpy.mockRestore();
  });
});
