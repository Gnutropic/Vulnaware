// Bulk-reopen tests for the /alerts page surface.
//
// Coverage posture mirrors tests/unit/alerts-bulk-resolve.test.tsx
// for the presentational bits (parseSelectedParam round-trip, the
// bulk-bar "Reopen selected" CTA, the per-row indicator chips). The
// four contract-bound scenarios from the bulk-reopen brief — happy
// path, role gate, idempotent no-op, mixed selection — live against
// `runBulkReopen` directly so the full page island (router,
// searchParams, apiFetch, sonner) doesn't need to be mocked. The
// helper carries the parallel fan-out + parsed-envelope guard + the
// per-row outcome map + the optimistic flip; the page island wraps it
// with React state wiring, so a fan-out-level test is sufficient to
// pin the contract.
//
// Why the helper path:
//   - The page handler reads `data.items`, `selection`, `pendingBulkIds`,
//     and writes `bulkResults`, `data.items`, `selection` plus a
//     sonner toast. To test it through React we'd need to mock
//     next/navigation, sonner, and mount the full island; to test
//     the contract we only need the intermediate (data items, selection,
//     stubbed fetch) and the emitted (outcomes map, post-flip items,
//     allOk flag). That intermediate set IS runBulkReopen's surface.

// React 19's act() refuses unless the test environment opts in
// explicitly. Set before any React import.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlertsBulkActionBar } from '@/components/dashboard/alerts-bulk-action-bar';
import { runBulkReopen } from '@/lib/business/alerts-bulk-reopen';
import { buildSelectedParam, parseSelectedParam } from '@/lib/business/alerts-selection';
import type { AlertItem } from '@/lib/contracts/alerts';

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

function makeRow(id: string, status: 'open' | 'resolved'): AlertItem {
  return {
    id,
    teamId: 'team-1',
    findingId: `f-${id}`,
    severity: 'high',
    status,
    source: 'kev',
    assigneeId: null,
    ownerId: null,
    ownerName: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    acknowledgedAt: null,
    snoozedUntil: null,
    cveId: `CVE-2026-1${id}`,
    vulnerabilityTitle: 'test vuln',
    asset: { host: 'edge.example.com', port: 443, protocol: 'tcp' },
    triggeredBy: 'ci-webhook',
    commentCount: 0,
    falsePositiveReason: null,
    closingNote: null,
    remediatedAt: null,
  };
}

function makeReopenResponse(id: string, status: 'open' = 'open') {
  return new Response(
    JSON.stringify({
      id,
      status,
      statusChangedAt: '2026-07-02T09:00:00.000Z',
      acknowledgedAt: null,
      // The widened AlertResolveResponse carries the close-stamp trio
      // alongside the earlier quartuple so the parse-safeParse inside
      // runBulkReopen doesn't schema-drift on the response. Trio is
      // null on a row that just reopened (matching the /reopen route's
      // explicit clears on statusChangedAt + the trio).
      closedAt: null,
      closedBy: null,
      closingNote: null,
      // Reopen trio. Stamped on the same write the /reopen route fires
      // and surfaced on the parsed envelope echo. The mock stamps the
      // three columns with a fresh timestamp so a future schema-drift
      // check on the response shape pins the trio explicitly.
      reopenedAt: '2026-07-02T09:00:00.000Z',
      reopenedBy: 'user-1',
      reopenReason: null,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('parseSelectedParam / buildSelectedParam (round-trip)', () => {
  it('round-trips a mixed selection through the same encoder', () => {
    const set = new Set(['a', 'b', 'c']);
    const encoded = buildSelectedParam(set);
    expect(encoded).not.toBeNull();
    expect(parseSelectedParam(new URLSearchParams(`selected=${encoded ?? ''}`))).toEqual(set);
  });

  it('returns null for an empty collection so the URL strips ?selected=', () => {
    expect(buildSelectedParam(new Set())).toBeNull();
    expect(buildSelectedParam([])).toBeNull();
  });
});

describe('AlertsBulkActionBar — Reopen selected CTA', () => {
  it('renders the Reopen selected button alongside Mark selected resolved', async () => {
    const host = await renderBar({
      selectionCount: 2,
      results: new Map(),
      pending: false,
      onResolve: () => {},
      onReopenSelected: () => {},
      onClear: () => {},
    });
    const reopenCta = host.querySelector('[data-testid="bulk-reopen-cta"]');
    const resolveCta = host.querySelector('[data-testid="bulk-resolve-cta"]');
    expect(reopenCta).not.toBeNull();
    expect(resolveCta).not.toBeNull();
    expect(reopenCta?.textContent?.trim().toLowerCase()).toContain('reopen selected');
  });

  it('fires onReopenSelected when the Reopen selected CTA is clicked', async () => {
    const calls: string[] = [];
    const host = await renderBar({
      selectionCount: 1,
      results: new Map(),
      pending: false,
      onResolve: () => {
        calls.push('resolve');
      },
      onReopenSelected: () => {
        calls.push('reopen');
      },
      onClear: () => {},
    });
    await click(host.querySelector('[data-testid="bulk-reopen-cta"]'));
    expect(calls).toEqual(['reopen']);
  });

  it('disables the Reopen selected CTA while a fan-out is in flight', async () => {
    const host = await renderBar({
      selectionCount: 2,
      results: new Map(),
      pending: true,
      onResolve: () => {},
      onReopenSelected: () => {},
      onClear: () => {},
    });
    const reopenCta = host.querySelector(
      '[data-testid="bulk-reopen-cta"]',
    ) as HTMLButtonElement | null;
    const resolveCta = host.querySelector(
      '[data-testid="bulk-resolve-cta"]',
    ) as HTMLButtonElement | null;
    expect(reopenCta?.hasAttribute('disabled')).toBe(true);
    expect(resolveCta?.hasAttribute('disabled')).toBe(true);
  });
});

describe('runBulkReopen — contract scenarios', () => {
  it('parallel happy path: 3 resolved ids — fan out, paint ok, flip state', async () => {
    const a = makeRow('a', 'resolved');
    const b = makeRow('b', 'resolved');
    const c = makeRow('c', 'resolved');
    const items = [a, b, c];
    const selection = new Set(['a', 'b', 'c']);
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const match = url.match(/\/api\/alerts\/([^/]+)\/reopen/);
      const id = match?.[1] ?? '';
      calls.push(id);
      return makeReopenResponse(id);
    });
    const result = await runBulkReopen({ items, selection, fetchImpl });
    expect(calls.sort()).toEqual(['a', 'b', 'c']);
    expect(result.candidates.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.get('b')).toBe('ok');
    expect(result.outcomes.get('c')).toBe('ok');
    expect(result.allOk).toBe(true);
    expect(result.okCount).toBe(3);
    expect(result.items.every((r) => r.status === 'open')).toBe(true);
  });

  it('role gate: 403 from /reopen paints err, leaves items untouched, allOk=false', async () => {
    const a = makeRow('a', 'resolved');
    const b = makeRow('b', 'resolved');
    const items = [a, b];
    const selection = new Set(['a', 'b']);
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    });
    const result = await runBulkReopen({ items, selection, fetchImpl });
    expect(result.outcomes.get('a')).toBe('err');
    expect(result.outcomes.get('b')).toBe('err');
    expect(result.allOk).toBe(false);
    expect(result.okCount).toBe(0);
    // Items unchanged on partial failure — the page's optimistic flip
    // is gated on allOk, so a single 4xx/5xx must not silently re-render
    // resolved rows as 'open' before the operator retries.
    expect(result.items).toBe(items);
    expect(result.items.every((r) => r.status === 'resolved')).toBe(true);
  });

  it('idempotent no-op: already-open id in selection is silently skipped — no fetch fired', async () => {
    const aResolved = makeRow('a', 'resolved');
    const bResolved = makeRow('b', 'resolved');
    const cOpen = makeRow('c', 'open');
    const items = [aResolved, bResolved, cOpen];
    const selection = new Set(['a', 'b', 'c']);
    const called: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const match = url.match(/\/api\/alerts\/([^/]+)\/reopen/);
      const id = match?.[1] ?? '';
      called.push(id);
      return makeReopenResponse(id);
    });
    const result = await runBulkReopen({ items, selection, fetchImpl });
    // Pre-filter requires status === 'resolved'; the already-open id
    // is dropped from the fan-out.
    expect(called.sort()).toEqual(['a', 'b']);
    expect(result.candidates.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(result.outcomes.has('c')).toBe(false);
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.get('b')).toBe('ok');
    expect(result.items.find((r) => r.id === 'c')?.status).toBe('open');
    // Post-flip row set: a+b flipped to open; c untouched.
    expect(result.items.find((r) => r.id === 'a')?.status).toBe('open');
    expect(result.items.find((r) => r.id === 'b')?.status).toBe('open');
    expect(result.allOk).toBe(true);
  });

  it('mixed selection: 2 resolved + 2 open, all selected — only resolved flip; final state all open', async () => {
    const items = [
      makeRow('a', 'resolved'),
      makeRow('b', 'resolved'),
      makeRow('c', 'open'),
      makeRow('d', 'open'),
    ];
    const selection = new Set(['a', 'b', 'c', 'd']);
    const called: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const match = url.match(/\/api\/alerts\/([^/]+)\/reopen/);
      const id = match?.[1] ?? '';
      called.push(id);
      return makeReopenResponse(id);
    });
    const result = await runBulkReopen({ items, selection, fetchImpl });
    expect(called.sort()).toEqual(['a', 'b']);
    expect(result.outcomes.size).toBe(2);
    expect(result.outcomes.get('a')).toBe('ok');
    expect(result.outcomes.get('b')).toBe('ok');
    expect(result.allOk).toBe(true);
    expect(result.okCount).toBe(2);
    // Scenario's required end state for visible items: every row open.
    const counts = result.items.reduce(
      (acc, r) => {
        acc[r.status] += 1;
        return acc;
      },
      { open: 0, resolved: 0 } as Record<'open' | 'resolved', number>,
    );
    expect(counts).toEqual({ open: 4, resolved: 0 });
  });

  // ===================== Optional-reason body shape =====================

  it('passes the shared reason through to every fan-out call (non-blank)', async () => {
    const items = [makeRow('a', 'resolved'), makeRow('b', 'resolved')];
    const selection = new Set(['a', 'b']);
    const bodies: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const match = url.match(/\/api\/alerts\/([^/]+)\/reopen/);
      const id = match?.[1] ?? '';
      bodies[id] = JSON.parse(String(init?.body ?? '{}'));
      return makeReopenResponse(id);
    });
    const result = await runBulkReopen({
      items,
      selection,
      reason: 're-triage after patch rollout',
      fetchImpl,
    });
    expect(result.allOk).toBe(true);
    // Body shape mirrors the AlertReopenBody schema: `{reason: <trimmed>}`
    // — the helper trims once and posts the same body to every fan-out
    // so the route stamps one consistent reason on each reopen trio.
    expect(bodies.a).toEqual({ reason: 're-triage after patch rollout' });
    expect(bodies.b).toEqual({ reason: 're-triage after patch rollout' });
  });

  it('falls back to `{}` body when reason is undefined (mirrors the single-row reopen)', async () => {
    // `reason` is OPTIONAL on the helper AND OPTIONAL on the route's
    // zod body. An absence of `reason` on the helper means "post
    // `{}`" so the route stamps NULL on every row — parity with
    // the per-row Reopen button which fires the bare `{}` body for
    // backwards compat.
    const items = [makeRow('a', 'resolved'), makeRow('b', 'resolved')];
    const selection = new Set(['a', 'b']);
    const bodies: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const match = url.match(/\/api\/alerts\/([^/]+)\/reopen/);
      const id = match?.[1] ?? '';
      bodies[id] = JSON.parse(String(init?.body ?? '{}'));
      return makeReopenResponse(id);
    });
    const result = await runBulkReopen({ items, selection, fetchImpl });
    expect(result.allOk).toBe(true);
    expect(bodies.a).toEqual({});
    expect(bodies.b).toEqual({});
  });

  it('trims a whitespace-only reason to `{}` body (route stamps NULL on every row)', async () => {
    // Same path as the single-row input — whitespace-only inputs
    // are treated as empty after the helper's `.trim()` so the blank
    // branch fires the bare `{}` body shape. The page-side dialog
    // already presents the disabled submit gate on overflow but
    // does not gate on `.min(1)`, so a whitespace-only draft lands
    // here without a 400 round-trip.
    const items = [makeRow('a', 'resolved'), makeRow('b', 'resolved')];
    const selection = new Set(['a', 'b']);
    const bodies: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const match = url.match(/\/api\/alerts\/([^/]+)\/reopen/);
      const id = match?.[1] ?? '';
      bodies[id] = JSON.parse(String(init?.body ?? '{}'));
      return makeReopenResponse(id);
    });
    const result = await runBulkReopen({
      items,
      selection,
      reason: '   ',
      fetchImpl,
    });
    expect(result.allOk).toBe(true);
    expect(bodies.a).toEqual({});
    expect(bodies.b).toEqual({});
  });
});
