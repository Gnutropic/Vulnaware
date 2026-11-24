// Multi-select + bulk-resolve tests for the /alerts page surface.
//
// Coverage posture:
//   - Pure-TS round-trip on the URL <-> Set helpers
//     (`parseSelectedParam` / `buildSelectedParam`) — no React, no
//     router.
//   - Component-render assertions on `AlertsListCards` (the mobile
//     card row's checkbox state driven by `selectedIds`) and on
//     `AlertsBulkActionBar` (presentational surfaces for the working
//     set + per-row indicator chips).
//
// Why these boundaries:
//   - The two helpers are pure and Pin the round-trip that the page's
//     `effectiveQs` writer uses 1:1; they are the contract that lets
//     reloads / shared links preserve the bulk-resolve working set
//     and lets an empty selection strip `?selected=` from the URL.
//   - The cards + action bar are the user-visible parts of the
//     selection model that can be tested without spinning up the full
//     page island (which composes with `useRouter`, `useSearchParams`,
//     `apiFetch`, and a long chain of shadcn primitives — all mocked
//     away here).
//
// The `?selected=` URL state and the page-level fan-out are exercised
// transitively: the helpers below are what `parseFiltersFromParams`
// in the page calls, and the bulk-resolve route
// (`tests/unit/api/alerts-resolve-route.test.ts`) covers the
// idempotent-already-resolved branch end-to-end server-side.

// React 19's act() refuses unless the test environment opts in
// explicitly. Set before any React import.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { AlertsBulkActionBar } from '@/components/dashboard/alerts-bulk-action-bar';
import { AlertsListCards } from '@/components/dashboard/alerts-list-cards';
import { buildSelectedParam, parseSelectedParam } from '@/lib/business/alerts-selection';

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

async function renderCard(props: Parameters<typeof AlertsListCards>[0]) {
  container = document.createElement('div');
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  await act(async () => {
    created.render(<AlertsListCards {...props} />);
  });
  return container;
}

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

const ALERT_A = {
  id: 'a',
  teamId: 'team-1',
  findingId: 'f-1',
  severity: 'critical',
  status: 'open' as const,
  source: 'kev' as const,
  assigneeId: null,
  ownerId: null,
  ownerName: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  acknowledgedAt: null,
  snoozedUntil: null,
  cveId: 'CVE-2026-1001',
  vulnerabilityTitle: 'test vuln',
  asset: { host: 'edge.example.com', port: 443, protocol: 'tcp' },
  triggeredBy: 'ci-webhook' as const,
  commentCount: 0,
  falsePositiveReason: null,
  closingNote: null,
  remediatedAt: null,
};
const ALERT_B = {
  ...ALERT_A,
  id: 'b',
  cveId: 'CVE-2026-1002',
  source: 'vulncheck' as const,
  triggeredBy: 'scheduled' as const,
};
const ALERT_C = {
  ...ALERT_A,
  id: 'c',
  cveId: 'CVE-2026-1003',
  severity: 'medium',
  source: 'manual' as const,
  triggeredBy: 'manual' as const,
};

describe('parseSelectedParam', () => {
  it('decodes a comma-joined id list into a Set, deduping repeat ids', () => {
    const set = parseSelectedParam(new URLSearchParams('selected=a,a,b,c'));
    expect([...set].sort()).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty Set for a missing or empty `selected`', () => {
    expect(parseSelectedParam(new URLSearchParams('severity=high')).size).toBe(0);
    expect(parseSelectedParam(new URLSearchParams('selected=')).size).toBe(0);
  });

  it('round-trips through `buildSelectedParam` for arbitrary Sets', () => {
    const set = new Set(['a', 'b', 'c']);
    const encoded = buildSelectedParam(set);
    expect(encoded).not.toBeNull();
    expect(parseSelectedParam(new URLSearchParams(`selected=${encoded ?? ''}`))).toEqual(set);
  });
});

describe('buildSelectedParam', () => {
  it('returns null for an empty collection so the writer can delete the key', () => {
    expect(buildSelectedParam(new Set())).toBeNull();
    expect(buildSelectedParam([])).toBeNull();
  });

  it('joins a Set of ids into a comma-joined string', () => {
    const out = buildSelectedParam(new Set(['a', 'b']));
    expect(['a,b', 'b,a']).toContain(out);
  });
});

describe('AlertsListCards — selection state drives row-level checkbox', () => {
  it('renders per-card checkboxes in unchecked state when selectedIds is empty', async () => {
    const host = await renderCard({
      items: [ALERT_A, ALERT_B],
      selectedIds: new Set(),
      onToggle: () => {},
    });
    const checkboxes = Array.from(host.querySelectorAll('[role="checkbox"]'));
    expect(checkboxes.length).toBe(2);
    for (const cb of checkboxes) {
      expect(cb.getAttribute('data-state')).toBe('unchecked');
      expect(cb.getAttribute('aria-checked')).toBe('false');
    }
  });

  it('renders only selected rows with checked state (partial persistence)', async () => {
    const host = await renderCard({
      items: [ALERT_A, ALERT_B, ALERT_C],
      selectedIds: new Set(['a', 'c']),
      onToggle: () => {},
    });
    const checkboxes = Array.from(host.querySelectorAll('[role="checkbox"]'));
    expect(checkboxes).toHaveLength(3);
    const states = checkboxes
      .map((cb) =>
        cb.getAttribute('aria-label')?.endsWith(' a')
          ? 'a'
          : cb.getAttribute('aria-label')?.endsWith(' b')
            ? 'b'
            : 'c',
      )
      .map((label, idx) => ({
        label,
        state: checkboxes[idx]?.getAttribute('data-state'),
      }));
    expect(states).toEqual([
      { label: 'a', state: 'checked' },
      { label: 'b', state: 'unchecked' },
      { label: 'c', state: 'checked' },
    ]);
  });

  it('fires onToggle with the row id when a card checkbox is clicked', async () => {
    const calls: string[] = [];
    const host = await renderCard({
      items: [ALERT_A, ALERT_B],
      selectedIds: new Set(['a']),
      onToggle: (id) => {
        calls.push(id);
      },
    });
    const checkboxB = host.querySelector('[aria-label="Select alert b"]');
    await click(checkboxB);
    expect(calls).toEqual(['b']);
  });
});

describe('AlertsBulkActionBar — presentational surface for the working set', () => {
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

  it('shows the N-selected caption and both control buttons when selectionCount>0', async () => {
    const host = await renderBar({
      selectionCount: 3,
      results: new Map(),
      pending: false,
      onResolve: () => {},
      onReopenSelected: () => {},
      onClear: () => {},
    });
    expect(host.textContent ?? '').toContain('3 alerts selected');
    const buttons = Array.from(host.querySelectorAll('button')).map((b) =>
      (b.textContent ?? '').trim().toLowerCase(),
    );
    expect(buttons).toContain('clear');
    expect(buttons).toContain('reopen selected');
    expect(buttons).toContain('mark selected resolved');
  });

  it('paints per-row indicator chips from the result map (ok / err)', async () => {
    const results = new Map<string, 'ok' | 'err'>([
      ['a', 'ok'],
      ['b', 'err'],
    ]);
    const host = await renderBar({
      selectionCount: 2,
      results,
      pending: false,
      onResolve: () => {},
      onClear: () => {},
    });
    const ok = host.querySelector('[data-testid="bulk-indicator-a"]');
    const err = host.querySelector('[data-testid="bulk-indicator-b"]');
    expect(ok).not.toBeNull();
    expect(ok?.textContent?.trim().toLowerCase()).toContain('a');
    expect(err).not.toBeNull();
    expect(err?.textContent?.trim().toLowerCase()).toContain('b');
  });

  it('disables both control buttons while a fan-out is in flight', async () => {
    const host = await renderBar({
      selectionCount: 2,
      results: new Map(),
      pending: true,
      onResolve: () => {},
      onClear: () => {},
    });
    const buttons = Array.from(host.querySelectorAll('button'));
    for (const button of buttons) {
      expect(button.hasAttribute('disabled')).toBe(true);
    }
  });
});
