// Pure rendering smoke test for the stakeholder-summary client
// island. Pins the wire contract:
//
//   - Card chrome renders the "Stakeholder summary" eyebrow +
//     "AI executive brief" header + "Plain-English summary for
//     leadership" descriptor and the streaming-state trigger button on
//     initial mount.
//   - Streaming the upstream SSE pump writes the joined paragraph into
//     a `<p data-testid="stakeholder-summary-text">` once the stream
//     closes and exposes a "Copy summary" button.
//   - Clicking Copy summary writes the full streamed text (trimmed) to
//     the clipboard via `navigator.clipboard.writeText`.
//   - An upstream 503 surfaces the unavailable-state copy (no Copy
//     button is rendered).
//
// Renders through React's createRoot into jsdom; no DB, no apiFetch,
// no real fetch — we spy on globalThis.fetch and feed canned SSE
// chunks for the streaming branch (and a canned 503 JSON envelope for
// the unavailable branch).
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
import { StakeholderSummaryCard } from '@/components/dashboard/stakeholder-summary-card';

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
}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  await act(async () => {
    created.render(
      <StakeholderSummaryCard alertId={props.alertId} cveId={props.cveId} asset={props.asset} />,
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

describe('StakeholderSummaryCard', () => {
  it('renders the Stakeholder summary eyebrow + AI executive brief header + trigger button on mount', async () => {
    const host = await renderCard({ alertId: 'alert-1', cveId: 'CVE-2025-0001', asset: ASSET });
    const text = host.textContent ?? '';
    expect(text).toContain('Stakeholder summary');
    expect(text).toContain('AI executive brief');
    // The streaming-state trigger button is present on initial mount —
    // mirrors the explain-with-ai-card's idle-state "Explain with AI"
    // CTA.
    expect(host.querySelector('[data-testid="stakeholder-summary-text"]')).toBeNull();
    const trigger = buttonsByLabel(host, 'generate stakeholder summary')[0];
    expect(trigger).toBeDefined();
  });

  it('streams prose into a <p> and exposes the Copy summary button', async () => {
    const frames = [
      jsonFrame('Heartbleed is on the CISA KEV list, which means '),
      jsonFrame('attackers are using it in the wild. '),
      jsonFrame(
        'Our internet-facing TLS endpoint is exposed and a memory-leak ' +
          'exploit could reveal session tokens or private keys. ' +
          'For a thirty-second briefing, lead with: a known, actively-exploited ' +
          'TLS bug on the public edge. ' +
          'After the patch, confirm the new OpenSSL build, re-scan the host, ' +
          'and check the WAF logs for any prior exploit attempts.',
      ),
    ];
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => sseBodyFromFrames(frames));

    const host = await renderCard({ alertId: 'alert-1', cveId: 'CVE-2025-0001', asset: ASSET });
    const trigger = buttonsByLabel(host, 'generate stakeholder summary')[0];
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

    const paragraph = host.querySelector('[data-testid="stakeholder-summary-text"]');
    expect(paragraph).not.toBeNull();
    expect(paragraph?.tagName.toLowerCase()).toBe('p');
    const paragraphText = paragraph?.textContent?.trim() ?? '';
    expect(paragraphText).toContain('Heartbleed is on the CISA KEV list');
    expect(paragraphText).toContain('attackers are using it in the wild');
    expect(paragraphText).toContain('internet-facing TLS endpoint');
    expect(paragraphText).toContain('After the patch');

    // The Copy summary CTA renders in the header once the stream lands.
    const copyButton = buttonsByLabel(host, 'copy summary')[0];
    expect(copyButton).toBeDefined();

    // Only one fetch call was made — the stream pump — and it went to
    // the summary/stream endpoint (NOT the cached /api/.../summary JSON
    // surface).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toBe('/api/alerts/alert-1/summary/stream');
    fetchSpy.mockRestore();
  });

  it('clicking Copy summary writes the trimmed streamed paragraph to the clipboard', async () => {
    const paragraph =
      'Heartbleed is on the CISA KEV list, which means attackers are using it in the wild. ' +
      'Our internet-facing TLS endpoint is exposed and a memory-leak exploit could reveal ' +
      'session tokens or private keys. For a thirty-second briefing, lead with: a known, ' +
      'actively-exploited TLS bug on the public edge. After the patch, confirm the new ' +
      'OpenSSL build, re-scan the host, and check the WAF logs.';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => sseBodyFromFrames([jsonFrame(paragraph)]));

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    const host = await renderCard({ alertId: 'alert-1', cveId: 'CVE-2025-0001', asset: ASSET });
    const trigger = buttonsByLabel(host, 'generate stakeholder summary')[0];
    await clickButton(trigger);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });

    const copyButton = buttonsByLabel(host, 'copy summary')[0];
    expect(copyButton).toBeDefined();
    if (!copyButton) {
      throw new Error('expected copy summary button');
    }
    await clickButton(copyButton);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });

    // navigator.clipboard.writeText was called with the FULL trimmed
    // paragraph (NOT a step-joined string — the stakeholder brief is a
    // single paragraph).
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toBe(paragraph.trim());

    fetchSpy.mockRestore();
  });

  it('returns the unavailable-state copy when the upstream returns 503', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ error: 'unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const host = await renderCard({ alertId: 'alert-1', cveId: 'CVE-2025-0001', asset: ASSET });
    const trigger = buttonsByLabel(host, 'generate stakeholder summary')[0];
    expect(trigger).toBeDefined();
    await clickButton(trigger);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });

    // No paragraph has streamed in, so the prose <p> is not in the
    // tree, and the Copy summary CTA is not rendered.
    expect(host.querySelector('[data-testid="stakeholder-summary-text"]')).toBeNull();
    expect(buttonsByLabel(host, 'copy summary')[0]).toBeUndefined();

    // The unavailable copy is on the card so the operator can retry.
    const text = (host.textContent ?? '').toLowerCase();
    expect(text).toMatch(/temporarily unavailable|unavailable/);

    fetchSpy.mockRestore();
  });
});
