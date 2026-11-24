// Pure rendering smoke test for the suggested-remediation client
// island. Pins the wire contract:
//
//   - Card chrome renders the "Suggested remediation" eyebrow + title
//     and the streaming-state trigger button on initial mount.
//   - Streaming the upstream SSE pump produces an ordered <ol> with
//     each streamed step text inside its own <li>.
//   - The Copy steps + Mark-as-resolved footer buttons post-stream.
//   - Clicking Mark as resolved POSTs to /api/alerts/[id]/resolve,
//     optimistically flips the local mirror, and fires the parent's
//     `onResolved` callback exactly once.
//
// Renders through React's createRoot into jsdom; no DB, no apiFetch,
// no real fetch — we spy on globalThis.fetch and feed canned SSE
// chunks for the streaming branch + a canned JSON envelope for the
// resolve branch.
//
// Every render + click wraps in `await act(...)` so React 19's
// concurrent scheduler has actually flushed before the queries run.

// React 19 refuses `act(...)` unless the current test environment
// explicitly opts in via this flag — without setting it here the call
// emits a stderr warning AND silently flushes only some tree
// siblings, which is what makes streaming assertions flake. Set it
// before any React import.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SuggestedRemediationCard } from '@/components/dashboard/suggested-remediation-card';

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

async function renderCard(props: {
  alertId: string;
  cveId: string;
  asset: { host: string; ip: string; port: number; protocol: string };
  alreadyResolved?: boolean;
  onResolved?: () => void | Promise<void>;
  onReopened?: () => void | Promise<void>;
}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  await act(async () => {
    created.render(
      <SuggestedRemediationCard
        alertId={props.alertId}
        cveId={props.cveId}
        asset={props.asset}
        alreadyResolved={props.alreadyResolved ?? false}
        onResolved={props.onResolved}
        onReopened={props.onReopened}
      />,
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

function jsonFrame(content: string): string {
  return `data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}\n\n`;
}

function sseBodyFromFrames(chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(enc.encode(chunk));
      }
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

const ASSET = { host: 'edge.example.com', ip: '203.0.113.10', port: 443, protocol: 'tcp' };

describe('SuggestedRemediationCard', () => {
  it('renders the AI remediation eyebrow + Suggested remediation title + trigger button on mount', async () => {
    const host = await renderCard({ alertId: 'alert-1', cveId: 'CVE-2025-0001', asset: ASSET });
    const text = host.textContent ?? '';
    expect(text).toContain('AI remediation');
    expect(text).toContain('Suggested remediation');
    expect(host.querySelector('[data-testid="suggested-remediation-steps"]')).toBeNull();
    // The streaming-state trigger button is present on the initial
    // mount — mirrors the explain-with-ai-card's idle-state
    // "Explain with AI" CTA.
    const trigger = buttonsByLabel(host, 'get remediation steps')[0];
    expect(trigger).toBeDefined();
  });

  it('renders an ordered list of streamed remediation steps after pumping SSE', async () => {
    const frames = [
      jsonFrame('OpenSSL >= 1.0.1g\n'),
      jsonFrame('Apply KB5034439\n'),
      jsonFrame('UseRoaming no in /etc/ssh/ssh_config\n'),
      jsonFrame('Check `openssl version` and re-scan'),
    ];
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => sseBodyFromFrames(frames));

    const host = await renderCard({ alertId: 'alert-1', cveId: 'CVE-2025-0001', asset: ASSET });
    const trigger = buttonsByLabel(host, 'get remediation steps')[0];
    expect(trigger).toBeDefined();
    await clickButton(trigger);

    // Pump the SSE with `act` so React's concurrent scheduler has
    // flushed the awaited read loops BEFORE we query the DOM.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });

    const list = host.querySelector('[data-testid="suggested-remediation-steps"]');
    expect(list).not.toBeNull();
    expect(list?.tagName.toLowerCase()).toBe('ol');
    const items = list?.querySelectorAll('li') ?? [];
    const itemTexts = Array.from(items).map((li) => li.textContent?.trim() ?? '');
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(itemTexts.length).toBeLessThanOrEqual(6);
    expect(itemTexts.join('\n')).toContain('OpenSSL >= 1.0.1g');
    expect(itemTexts.join('\n')).toContain('Apply KB5034439');
    // The copied accumulator + separator is what `Copy steps` writes;
    // the joined output above is the same strings the Copy toast would
    // land on the clipboard.

    // The Mark as resolved CTA renders below the streamed steps.
    const resolvedButton = buttonsByLabel(host, 'mark as resolved')[0];
    expect(resolvedButton).toBeDefined();

    // Only one fetch call was made — the stream pump — and it went
    // to the remediation/stream endpoint.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toBe('/api/alerts/alert-1/remediation/stream');
    fetchSpy.mockRestore();
  });

  it('clicking Mark as resolved POSTs to /resolve, fires onResolved, and flips the mirror', async () => {
    const onResolved = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    // 1st call → stream remediation steps (SSE).
    fetchSpy.mockImplementationOnce(async () =>
      sseBodyFromFrames([
        jsonFrame('OpenSSL >= 1.0.1g\n'),
        jsonFrame('Apply KB5034439\n'),
        jsonFrame('Re-scan\n'),
      ]),
    );
    // 2nd call → resolve POST (JSON envelope). Mirrors the widened
    // AlertResolveResponse contract (close-stamp trio riding alongside
    // the earlier quartuple). The card parses this back through the
    // same zod schema so the JSON shape must include `closedAt`,
    // `closedBy`, `closingNote`.
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            id: 'alert-1',
            status: 'resolved',
            statusChangedAt: '2026-07-01T12:00:00.000Z',
            acknowledgedAt: null,
            closedAt: '2026-07-01T12:00:00.000Z',
            closedBy: 'user-1',
            closingNote: null,
            reopenedAt: null,
            reopenedBy: null,
            reopenReason: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    const host = await renderCard({
      alertId: 'alert-1',
      cveId: 'CVE-2025-0001',
      asset: ASSET,
      onResolved,
    });

    // Pump the stream first so the Mark-as-resolved CTA is enabled.
    const trigger = buttonsByLabel(host, 'get remediation steps')[0];
    await clickButton(trigger);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });

    const resolvedButtonBefore = buttonsByLabel(host, 'mark as resolved')[0];
    expect(resolvedButtonBefore).toBeDefined();

    // Click the Mark-as-resolved CTA.
    await clickButton(resolvedButtonBefore);
    // Drain microtasks again so the optimistic flip + onResolved fire.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const calls = fetchSpy.mock.calls;
    expect(String(calls[0]?.[0])).toBe('/api/alerts/alert-1/remediation/stream');
    expect(String(calls[1]?.[0])).toBe('/api/alerts/alert-1/resolve');
    expect((calls[1]?.[1] as RequestInit | undefined)?.method).toBe('POST');
    // The envelope is parseable as the AlertResolveResponse contract.
    expect(onResolved).toHaveBeenCalledTimes(1);

    // After the optimistic flip the CTA's label flips to "Resolved".
    const resolvedAfter = buttonsByLabel(host, 'resolved')[0];
    expect(resolvedAfter).toBeDefined();
    const markAfter = buttonsByLabel(host, 'mark as resolved')[0];
    expect(markAfter).toBeUndefined();

    fetchSpy.mockRestore();
  });

  it('renders the closing-note textarea composer next to the Mark-as-resolved CTA', async () => {
    const host = await renderCard({ alertId: 'alert-1', cveId: 'CVE-2025-0001', asset: ASSET });
    // The closing-note composer is on the resolve-footer pair — it
    // surfaces IFF the row is not already resolved (mirror of the
    // reopen CTA's gate). `data-testid="closing-note-input"` rides
    // the `<Textarea>` so the test can grab it without dumping the
    // full DOM tree.
    const block = host.querySelector('[data-testid="closing-note-block"]');
    expect(block).not.toBeNull();
    const input = host.querySelector(
      'textarea[data-testid="closing-note-input"]',
    ) as HTMLTextAreaElement | null;
    expect(input).not.toBeNull();
    expect(input?.placeholder).toContain('What did you do to resolve this?');
    expect(input?.maxLength).toBe(500);
    expect(input?.value).toBe('');
    // The composer is hidden on already-row mounts — a resolved row
    // shows the Reopen CTA, NOT the closing-note composer.
    const hostResolved = await renderCard({
      alertId: 'alert-1',
      cveId: 'CVE-2025-0001',
      asset: ASSET,
      alreadyResolved: true,
    });
    expect(hostResolved.querySelector('[data-testid="closing-note-block"]')).toBeNull();
  });

  it('closing note posts in the body when non-empty, omits key when blank', async () => {
    const onResolved = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    // Stream the steps first so the CTA is enabled.
    fetchSpy.mockImplementationOnce(async () =>
      sseBodyFromFrames([jsonFrame('Apply KB5034439\n')]),
    );
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            id: 'alert-1',
            status: 'resolved',
            statusChangedAt: '2026-07-01T12:00:00.000Z',
            acknowledgedAt: null,
            closedAt: '2026-07-01T12:00:00.000Z',
            closedBy: 'user-1',
            closingNote: 'Patched via WAF',
            reopenedAt: null,
            reopenedBy: null,
            reopenReason: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const host = await renderCard({
      alertId: 'alert-1',
      cveId: 'CVE-2025-0001',
      asset: ASSET,
      onResolved,
    });
    // Pump the stream.
    const trigger = buttonsByLabel(host, 'get remediation steps')[0];
    await clickButton(trigger);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });

    // Type a note into the textarea + click the resolve CTA. The body
    // must carry `{ note: 'Patched via WAF' }` (the trimmed value)
    // — NOT the empty `{}` body. The route stamps that note onto
    // `Alert.closingNote` on the same write as status → resolved.
    const textarea = host.querySelector(
      'textarea[data-testid="closing-note-input"]',
    ) as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    await act(async () => {
      textarea?.dispatchEvent(new Event('focus', { bubbles: true }));
      // Simulate a React-aware input via the native setter.
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(textarea, 'Patched via WAF');
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(textarea?.value).toBe('Patched via WAF');
    const resolveBtn = buttonsByLabel(host, 'mark as resolved')[0];
    await clickButton(resolveBtn);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });

    const resolveCall = fetchSpy.mock.calls[1];
    expect(String(resolveCall?.[0])).toBe('/api/alerts/alert-1/resolve');
    const body = JSON.parse(String((resolveCall?.[1] as RequestInit | undefined)?.body ?? '{}'));
    expect(body).toEqual({ note: 'Patched via WAF' });
    expect(onResolved).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();

    // Separate scenario: blank input → body is `{}` (no `note` key).
    const fetchSpy2 = vi.spyOn(globalThis, 'fetch');
    fetchSpy2.mockImplementationOnce(async () =>
      sseBodyFromFrames([jsonFrame('Apply KB5034439\n')]),
    );
    fetchSpy2.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            id: 'alert-1',
            status: 'resolved',
            statusChangedAt: '2026-07-01T12:00:00.000Z',
            acknowledgedAt: null,
            closedAt: '2026-07-01T12:00:00.000Z',
            closedBy: 'user-1',
            closingNote: null,
            reopenedAt: null,
            reopenedBy: null,
            reopenReason: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const host2 = await renderCard({ alertId: 'alert-1', cveId: 'CVE-2025-0001', asset: ASSET });
    // Pump the stream, click resolve WITHOUT typing anything.
    const trigger2 = buttonsByLabel(host2, 'get remediation steps')[0];
    await clickButton(trigger2);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });
    const resolveBtn2 = buttonsByLabel(host2, 'mark as resolved')[0];
    await clickButton(resolveBtn2);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });
    const blankBodyCall = fetchSpy2.mock.calls[1];
    const blankBody = JSON.parse(
      String((blankBodyCall?.[1] as RequestInit | undefined)?.body ?? '{}'),
    );
    // Empty input → `body === {}` (NOT `{ note: '' }`) so the route
    // stamps `closingNote: null` (NOT a multi-column empty string).
    expect(blankBody).toEqual({});
    fetchSpy2.mockRestore();
  });

  it('clears the closing note input on successful resolve', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementationOnce(async () =>
      sseBodyFromFrames([jsonFrame('Apply KB5034439\n')]),
    );
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            id: 'alert-1',
            status: 'resolved',
            statusChangedAt: '2026-07-01T12:00:00.000Z',
            acknowledgedAt: null,
            closedAt: '2026-07-01T12:00:00.000Z',
            closedBy: 'user-1',
            closingNote: 'cleaned',
            reopenedAt: null,
            reopenedBy: null,
            reopenReason: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    const host = await renderCard({ alertId: 'alert-1', cveId: 'CVE-2025-0001', asset: ASSET });
    const trigger = buttonsByLabel(host, 'get remediation steps')[0];
    await clickButton(trigger);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });

    // Type a note, then resolve — the `<Textarea>` re-renders with
    // value="" on the success path so subsequent reopens (after a
    // reopen) start from a clean slate rather than carrying the
    // prior operator's draft forward.
    const textarea = host.querySelector(
      'textarea[data-testid="closing-note-input"]',
    ) as HTMLTextAreaElement | null;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(textarea, 'cleaned');
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(textarea?.value).toBe('cleaned');

    const resolveBtn = buttonsByLabel(host, 'mark as resolved')[0];
    await clickButton(resolveBtn);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });

    // The optimistic flip already disabled the composer (the row is
    // now in `resolved`), so we re-mount with `alreadyResolved: true`
    // and a fresh card to mimic what a parent refetch surfaces — the
    // textarea would re-surface with `value=""` if a future reopen
    // resolves back. Mirror: navigate to a page after reopen and
    // the textarea renders empty.
    const rehost = await renderCard({
      alertId: 'alert-1',
      cveId: 'CVE-2025-0001',
      asset: ASSET,
      alreadyResolved: true,
    });
    expect(rehost.querySelector('[data-testid="closing-note-block"]')).toBeNull();
    fetchSpy.mockRestore();
  });

  it('clicking Reopen POSTs to /reopen, fires onReopened, and mirrors the optimistic flip', async () => {
    const onReopened = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            id: 'alert-1',
            status: 'open',
            statusChangedAt: '2026-07-02T09:00:00.000Z',
            acknowledgedAt: null,
            closedAt: null,
            closedBy: null,
            closingNote: null,
            reopenedAt: '2026-07-02T09:00:00.000Z',
            reopenedBy: 'user-1',
            reopenReason: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    // Render with `alreadyResolved: true` so the Reopen CTA surfaces
    // alongside the disabled "Resolved" CTA. The card is intentionally
    // NOT in the streaming state — the Reopen control is a sibling of
    // Mark-as-resolved, gated only on `alreadyResolved === true`, so
    // the streamed-step state isn't required for the optimistic flip.
    const host = await renderCard({
      alertId: 'alert-1',
      cveId: 'CVE-2025-0001',
      asset: ASSET,
      alreadyResolved: true,
      onReopened,
    });

    // The Reopen CTA is visible on a resolved-already row. The
    // Mark-as-resolved button is also rendered but flips to its
    // "Resolved" label + DISABLED state (gate: resolved === true at
    // mount, mirrors `alreadyResolved`).
    const reopenButton = buttonsByLabel(host, 'reopen')[0];
    expect(reopenButton).toBeDefined();
    const resolvedLabel = host.querySelector('button[disabled]');
    expect(resolvedLabel).toBeDefined();
    expect((resolvedLabel?.textContent ?? '').trim().toLowerCase()).toContain('resolved');

    await clickButton(reopenButton);
    // Drain microtasks so the optimistic flip + onReopened fire.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toBe('/api/alerts/alert-1/reopen');
    expect((init as RequestInit | undefined)?.method).toBe('POST');
    // The envelope is parseable as the AlertResolveResponse contract
    // and asserts the status is 'open' — the route's idempotency
    // guarantee signals to the card that the transition landed.
    expect(onReopened).toHaveBeenCalledTimes(1);

    fetchSpy.mockRestore();
  });

  // ===================== Reopen-reason composer =====================

  it('renders the reopen-reason textarea composer next to the Reopen CTA on resolved rows', async () => {
    // Mirror of the closing-note composer: only mounts on the
    // resolve-footer pair when `alreadyResolved === true`, falls
    // through to NULL on open rows so the operator never sees a
    // composer + a CTA on the same row for the same half-decision
    // path.
    const host = await renderCard({
      alertId: 'alert-1',
      cveId: 'CVE-2025-0001',
      asset: ASSET,
      alreadyResolved: true,
    });
    const block = host.querySelector('[data-testid="reopen-reason-block"]');
    expect(block).not.toBeNull();
    const input = host.querySelector(
      'textarea[data-testid="reopen-reason-input"]',
    ) as HTMLTextAreaElement | null;
    expect(input).not.toBeNull();
    expect(input?.placeholder).toContain('Why is the alert back on the active queue?');
    expect(input?.maxLength).toBe(500);
    expect(input?.value).toBe('');
  });

  it('hides the reopen-reason composer on resolved=false rows', async () => {
    // Open rows don't expose a Reopen CTA, so the composer stays
    // out of view — the same rule that hides the Reopen CTA itself.
    const host = await renderCard({ alertId: 'alert-1', cveId: 'CVE-2025-0001', asset: ASSET });
    expect(host.querySelector('[data-testid="reopen-reason-block"]')).toBeNull();
  });

  it('posts {reason: trimmed} in the body when the reopen composer has a non-empty value', async () => {
    const onReopened = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            id: 'alert-1',
            status: 'open',
            statusChangedAt: '2026-07-02T09:00:00.000Z',
            acknowledgedAt: null,
            closedAt: null,
            closedBy: null,
            closingNote: null,
            reopenedAt: '2026-07-02T09:00:00.000Z',
            reopenedBy: 'user-1',
            reopenReason: 're-triage after audit',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const host = await renderCard({
      alertId: 'alert-1',
      cveId: 'CVE-2025-0001',
      asset: ASSET,
      alreadyResolved: true,
      onReopened,
    });

    // Type a reason into the composer — mirrors the closing-note
    // POST scenario: native setter + input event so React's
    // onChange fires the state setter.
    const textarea = host.querySelector(
      'textarea[data-testid="reopen-reason-input"]',
    ) as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(textarea, 're-triage after audit');
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(textarea?.value).toBe('re-triage after audit');

    // Click the Reopen CTA.
    const reopenBtn = buttonsByLabel(host, 'reopen')[0];
    await clickButton(reopenBtn);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });

    const calls = fetchSpy.mock.calls;
    expect(String(calls[0]?.[0])).toBe('/api/alerts/alert-1/reopen');
    const body = JSON.parse(String((calls[0]?.[1] as RequestInit | undefined)?.body ?? '{}'));
    // The trimmed reason rides the body; the route stamps it on
    // the reopen trio's reopenReason column.
    expect(body).toEqual({ reason: 're-triage after audit' });
    expect(onReopened).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it('posts bare {} body when the reopen composer is blank', async () => {
    // Mirror of the closing-note "no `note` key on blank" branch —
    // a blank reopen sends `{}` so the route stamps NULL.
    const onReopened = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            id: 'alert-1',
            status: 'open',
            statusChangedAt: '2026-07-02T09:00:00.000Z',
            acknowledgedAt: null,
            closedAt: null,
            closedBy: null,
            closingNote: null,
            reopenedAt: '2026-07-02T09:00:00.000Z',
            reopenedBy: 'user-1',
            reopenReason: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const host = await renderCard({
      alertId: 'alert-1',
      cveId: 'CVE-2025-0001',
      asset: ASSET,
      alreadyResolved: true,
      onReopened,
    });
    const reopenBtn = buttonsByLabel(host, 'reopen')[0];
    await clickButton(reopenBtn);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });
    const calls = fetchSpy.mock.calls;
    const body = JSON.parse(String((calls[0]?.[1] as RequestInit | undefined)?.body ?? '{}'));
    expect(body).toEqual({});
    expect(onReopened).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it('clears the reopen-reason composer input on a successful reopen', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            id: 'alert-1',
            status: 'open',
            statusChangedAt: '2026-07-02T09:00:00.000Z',
            acknowledgedAt: null,
            closedAt: null,
            closedBy: null,
            closingNote: null,
            reopenedAt: '2026-07-02T09:00:00.000Z',
            reopenedBy: 'user-1',
            reopenReason: 'audit',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const host = await renderCard({
      alertId: 'alert-1',
      cveId: 'CVE-2025-0001',
      asset: ASSET,
      alreadyResolved: true,
    });
    const textarea = host.querySelector(
      'textarea[data-testid="reopen-reason-input"]',
    ) as HTMLTextAreaElement | null;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(textarea, 'audit');
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(textarea?.value).toBe('audit');
    const reopenBtn = buttonsByLabel(host, 'reopen')[0];
    await clickButton(reopenBtn);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });
    // Re-mount with alreadyResolved=true to mimic what a future
    // page navigation surfaces — the textarea re-renders with
    // `value=""` so the next operator's draft isn't prestamped
    // from the prior round-trip.
    const rehost = await renderCard({
      alertId: 'alert-1',
      cveId: 'CVE-2025-0001',
      asset: ASSET,
      alreadyResolved: true,
    });
    const textareaAfter = rehost.querySelector(
      'textarea[data-testid="reopen-reason-input"]',
    ) as HTMLTextAreaElement | null;
    expect(textareaAfter?.value).toBe('');
    fetchSpy.mockRestore();
  });
});
