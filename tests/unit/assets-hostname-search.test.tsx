// @vitest-environment jsdom

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn().mockResolvedValue({ items: [], total: 0 }),
}));

import { AlertsTextQueryInput } from '@/components/dashboard/alerts-text-query-input';
import { AssetsTable } from '@/components/dashboard/assets-table';

const { useRouter, useSearchParams } = await import('next/navigation');
const { apiFetch } = await import('@/lib/api-client');
const { default: AssetsPage } = await import('@/app/(dashboard)/assets/page');

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function setSearchParams(qs: string) {
  const params = new URLSearchParams(qs);
  (useSearchParams as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => params);
  window.history.replaceState(null, '', `/assets${params.toString() ? `?${params}` : ''}`);
}

function makeRouter() {
  const replace = vi.fn<(href: string, options?: { scroll?: boolean }) => void>((href) => {
    window.history.replaceState(null, '', href);
  });
  (useRouter as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ replace });
  return replace;
}

async function render(element: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
  return container;
}

function setNativeInputValue(input: HTMLInputElement, value: string) {
  const prototype = Object.getPrototypeOf(input) as object;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.useFakeTimers();
  (apiFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], total: 0 });
});

describe('asset hostname search', () => {
  it('preserves filters and pagination when changing the unresolved sort', async () => {
    const replace = makeRouter();
    setSearchParams(
      'q=api.example.invalid&severity=high&status=open&minRiskScore=5&scanRecency=last7d&riskTrend=rising&sort=openCount&page=3&pageSize=10',
    );
    const host = await render(<AssetsPage />);
    await act(async () => await Promise.resolve());

    const unresolvedButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Unresolved alerts'),
    );
    expect(unresolvedButton).not.toBeUndefined();
    await act(async () => unresolvedButton?.click());
    await act(async () => await Promise.resolve());

    expect(replace).toHaveBeenLastCalledWith(
      '/assets?q=api.example.invalid&severity=high&status=open&minRiskScore=5&scanRecency=last7d&riskTrend=rising&sort=unresolvedCount&page=3&pageSize=10',
      { scroll: false },
    );
  });

  it('preserves filters and pagination when changing the 30-day change sort', async () => {
    const replace = makeRouter();
    setSearchParams(
      'q=api.example.invalid&severity=high&status=open&minRiskScore=5&scanRecency=last7d&riskTrend=rising&sort=openCount&page=3&pageSize=10',
    );
    const host = await render(<AssetsPage />);
    await act(async () => await Promise.resolve());

    const changeButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('30-day change'),
    );
    expect(changeButton).not.toBeUndefined();
    await act(async () => changeButton?.click());
    await act(async () => await Promise.resolve());

    expect(replace).toHaveBeenLastCalledWith(
      '/assets?q=api.example.invalid&severity=high&status=open&minRiskScore=5&scanRecency=last7d&riskTrend=rising&sort=riskScoreChange&page=3&pageSize=10',
      { scroll: false },
    );
  });

  it('preserves active filters and pagination when changing the latest scan date sort', async () => {
    const replace = makeRouter();
    setSearchParams(
      'q=api.example.invalid&severity=high&status=open&minRiskScore=5&scanRecency=last7d&riskTrend=rising&alertPresence=with&sort=openCount&page=3&pageSize=10',
    );
    const host = await render(<AssetsPage />);
    await act(async () => await Promise.resolve());

    const scanButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Latest scan'),
    );
    expect(scanButton).not.toBeUndefined();
    await act(async () => scanButton?.click());
    await act(async () => await Promise.resolve());

    const expectedQuery =
      'q=api.example.invalid&severity=high&status=open&minRiskScore=5&scanRecency=last7d&riskTrend=rising&alertPresence=with&sort=latestScanAt&page=3&pageSize=10';
    expect(replace).toHaveBeenLastCalledWith(`/assets?${expectedQuery}`, { scroll: false });
    expect(apiFetch).toHaveBeenLastCalledWith(`/api/assets?${expectedQuery}`, expect.any(Object));

    await act(async () => scanButton?.click());
    await act(async () => await Promise.resolve());
    const oldestQuery = expectedQuery.replace('sort=latestScanAt', 'sort=latestScanAt%3Aasc');
    expect(replace).toHaveBeenLastCalledWith(`/assets?${oldestQuery}`, { scroll: false });
    expect(apiFetch).toHaveBeenLastCalledWith(`/api/assets?${oldestQuery}`, expect.any(Object));
  });

  it('uses hostname copy and preserves every existing list parameter when writing q', async () => {
    const replace = makeRouter();
    setSearchParams(
      'severity=high&status=open&scanRecency=last30d&sort=name&page=2&pageSize=50',
    );
    const host = await render(
      <AlertsTextQueryInput
        basePath="/assets"
        inputId="assets-hostname-search"
        label="Search assets by hostname"
        placeholder="Search hostname…"
        clearLabel="Clear hostname search"
        preserveSelection
      />,
    );

    const input = host.querySelector<HTMLInputElement>('#assets-hostname-search');
    expect(input?.placeholder).toBe('Search hostname…');
    expect(host.textContent).not.toContain('Search alerts by');
    if (!input) throw new Error('expected hostname input');

    await act(async () => setNativeInputValue(input, '  app.example.invalid  '));
    await act(async () => vi.advanceTimersByTime(260));

    expect(replace).toHaveBeenCalledTimes(1);
    const params = new URLSearchParams(replace.mock.calls[0]?.[0].split('?')[1]);
    expect(params.get('q')).toBe('app.example.invalid');
    expect(params.get('severity')).toBe('high');
    expect(params.get('status')).toBe('open');
    expect(params.get('scanRecency')).toBe('last30d');
    expect(params.get('sort')).toBe('name');
    expect(params.get('page')).toBe('2');
    expect(params.get('pageSize')).toBe('50');
  });

  it('clears only q and leaves the rest of the list URL intact', async () => {
    const replace = makeRouter();
    setSearchParams('q=app.example.invalid&severity=high&status=open&page=2&pageSize=50');
    const host = await render(
      <AlertsTextQueryInput
        initialValue="app.example.invalid"
        basePath="/assets"
        inputId="assets-hostname-search"
        clearLabel="Clear hostname search"
        preserveSelection
      />,
    );

    const clear = host.querySelector<HTMLButtonElement>('button[aria-label="Clear hostname search"]');
    expect(clear).not.toBeNull();
    await act(async () => clear?.click());
    await act(async () => vi.advanceTimersByTime(260));

    expect(replace).toHaveBeenCalledTimes(1);
    const params = new URLSearchParams(replace.mock.calls[0]?.[0].split('?')[1]);
    expect(params.has('q')).toBe(false);
    expect(params.get('severity')).toBe('high');
    expect(params.get('status')).toBe('open');
    expect(params.get('page')).toBe('2');
    expect(params.get('pageSize')).toBe('50');
  });

  it('distinguishes a hostname no-match from an unfiltered empty inventory', async () => {
    setSearchParams('q=missing.example.invalid');
    const filtered = await render(
      <AssetsTable
        items={[]}
        sort="openCount"
        onSortChange={vi.fn()}
        query="missing.example.invalid"
        clearQueryHref="/assets?severity=high"
      />,
    );
    expect(filtered.textContent).toContain(
      'No assets matching “missing.example.invalid” were found in the active workspace.',
    );
    expect(filtered.querySelector('a[href="/assets?severity=high"]')?.textContent).toBe(
      'Clear hostname search',
    );

    await act(async () => root?.unmount());
    root = null;
    filtered.remove();
    container = null;
    const unfiltered = await render(
      <AssetsTable items={[]} sort="openCount" onSortChange={vi.fn()} />,
    );
    expect(unfiltered.textContent).toContain(
      'No assets have been discovered in the active workspace yet.',
    );
    expect(unfiltered.textContent).not.toContain('Clear hostname search');
  });

  it('renders risk scores and toggles the accessible risk sort in both table layouts', async () => {
    const onSortChange = vi.fn();
    const host = await render(
      <AssetsTable
        items={[
          {
            name: 'risk.example.invalid',
            assetType: 'web',
            scanCount30d: 2,
            openCount: 1,
            unresolvedCount: 3,
            criticalCount: 0,
            highestUnresolvedSeverity: null,
            riskScore: 8.1,
            riskScoreChange: 1.9,
            lastActivityAt: null,
            latestScanAt: null,
            latestScanStatus: null,
          },
        ]}
        sort="riskScore"
        onSortChange={onSortChange}
      />,
    );

    expect(host.textContent).toContain('8.10 /10');
    expect(host.textContent?.match(/30-day scans: 2/g)).toHaveLength(1);
    expect(host.querySelector('th')?.parentElement?.textContent).toContain('30-day scans');
    expect(host.querySelectorAll('td').item(9).textContent).toBe('2');
    expect(host.textContent?.match(/Unresolved alerts 3/g)).toHaveLength(2);
    expect(host.querySelector('th[aria-sort="descending"]')?.textContent).toContain('Risk score');
    const riskButtons = Array.from(host.querySelectorAll('button')).filter((button) =>
      button.textContent?.includes('Risk score'),
    );
    expect(riskButtons).toHaveLength(2);
    expect(riskButtons[0]?.getAttribute('aria-label')).toBe(
      'Sort by risk score. Current order: descending. Activate to sort ascending.',
    );

    await act(async () => riskButtons[0]?.click());

    expect(onSortChange).toHaveBeenCalledWith('riskScore:asc');
  });

  it('renders signed 30-day changes and unavailable history in both layouts', async () => {
    const host = await render(
      <AssetsTable
        items={[
          {
            name: 'increase.example.invalid',
            assetType: 'web',
            scanCount30d: 0,
            openCount: 1,
            unresolvedCount: 1,
            criticalCount: 0,
            highestUnresolvedSeverity: null,
            riskScore: 8.1,
            riskScoreChange: 1.9,
            lastActivityAt: null,
            latestScanAt: null,
            latestScanStatus: null,
          },
          {
            name: 'decrease.example.invalid',
            assetType: 'web',
            scanCount30d: 0,
            openCount: 1,
            unresolvedCount: 1,
            criticalCount: 0,
            highestUnresolvedSeverity: null,
            riskScore: 4.1,
            riskScoreChange: -1.9,
            lastActivityAt: null,
            latestScanAt: null,
            latestScanStatus: null,
          },
          {
            name: 'steady.example.invalid',
            assetType: 'web',
            scanCount30d: 0,
            openCount: 1,
            unresolvedCount: 1,
            criticalCount: 0,
            highestUnresolvedSeverity: null,
            riskScore: 4.1,
            riskScoreChange: 0,
            lastActivityAt: null,
            latestScanAt: null,
            latestScanStatus: null,
          },
          {
            name: 'unavailable.example.invalid',
            assetType: 'web',
            scanCount30d: 0,
            openCount: 1,
            unresolvedCount: 0,
            criticalCount: 0,
            highestUnresolvedSeverity: null,
            riskScore: null,
            riskScoreChange: null,
            lastActivityAt: null,
            latestScanAt: null,
            latestScanStatus: null,
          },
        ]}
        sort="openCount"
        onSortChange={vi.fn()}
      />,
    );

    expect(host.textContent).toContain('Increased: +1.90 points');
    expect(host.textContent).toContain('Decreased: −1.90 points');
    expect(host.textContent).toContain('No change: 0.00 points');
    expect(host.textContent).toContain('Unavailable — need at least two dated scores');
    const changeValues = Array.from(
      host.querySelectorAll('[data-testid="asset-risk-score-change"]'),
    ).map((element) => element.textContent);
    expect(changeValues.filter((label) => label?.includes('Increased: +1.90 points'))).toHaveLength(
      2,
    );
    expect(changeValues.filter((label) => label?.includes('Decreased: −1.90 points'))).toHaveLength(
      2,
    );
    expect(changeValues.filter((label) => label?.includes('No change: 0.00 points'))).toHaveLength(
      2,
    );
    expect(
      changeValues.filter((label) => label?.includes('Unavailable — need at least two dated scores')),
    ).toHaveLength(2);
  });

  it('renders unresolved-alert sort controls in both layouts and toggles direction', async () => {
    const onSortChange = vi.fn();
    const host = await render(
      <AssetsTable
        items={[
          {
            name: 'zero.example.invalid',
            assetType: 'web',
            scanCount30d: 0,
            openCount: 0,
            unresolvedCount: 0,
            criticalCount: 0,
            highestUnresolvedSeverity: null,
            riskScore: null,
            riskScoreChange: null,
            lastActivityAt: null,
            latestScanAt: null,
            latestScanStatus: null,
          },
        ]}
        sort="unresolvedCount"
        onSortChange={onSortChange}
      />,
    );

    expect(host.textContent).toContain('Unresolved alerts 0');
    expect(host.querySelector('th[aria-sort="descending"]')?.textContent).toContain(
      'Unresolved alerts',
    );
    const unresolvedButtons = Array.from(host.querySelectorAll('button')).filter((button) =>
      button.textContent?.includes('Unresolved alerts'),
    );
    expect(unresolvedButtons).toHaveLength(2);
    expect(unresolvedButtons[0]?.getAttribute('aria-label')).toBe(
      'Sort by unresolved alerts. Current order: descending. Activate to sort ascending.',
    );

    await act(async () => unresolvedButtons[0]?.click());
    expect(onSortChange).toHaveBeenCalledWith('unresolvedCount:asc');

    await act(async () => root?.unmount());
    root = null;
    host.remove();
    container = null;
    const ascendingHost = await render(
      <AssetsTable
        items={[]}
        sort="unresolvedCount:asc"
        onSortChange={onSortChange}
      />,
    );
    expect(ascendingHost.querySelector('th[aria-sort="ascending"]')?.textContent).toContain(
      'Unresolved alerts',
    );
    const ascendingButton = Array.from(ascendingHost.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Unresolved alerts'),
    );
    expect(ascendingButton?.getAttribute('aria-label')).toBe(
      'Sort by unresolved alerts. Current order: ascending. Activate to sort descending.',
    );
    await act(async () => ascendingButton?.click());
    expect(onSortChange).toHaveBeenCalledWith('unresolvedCount');
  });

  it('renders 30-day change sort controls in both layouts and toggles direction', async () => {
    const onSortChange = vi.fn();
    const host = await render(
      <AssetsTable
        items={[]}
        sort="riskScoreChange"
        onSortChange={onSortChange}
      />,
    );

    expect(host.querySelector('th[aria-sort="descending"]')?.textContent).toContain('30-day change');
    const changeButtons = Array.from(host.querySelectorAll('button')).filter((button) =>
      button.textContent?.includes('30-day change'),
    );
    expect(changeButtons).toHaveLength(2);
    expect(changeButtons[0]?.getAttribute('aria-label')).toBe(
      'Sort by 30-day change. Current order: descending. Activate to sort ascending.',
    );

    await act(async () => changeButtons[0]?.click());
    expect(onSortChange).toHaveBeenCalledWith('riskScoreChange:asc');

    await act(async () => root?.unmount());
    root = null;
    host.remove();
    container = null;
    const ascendingHost = await render(
      <AssetsTable items={[]} sort="riskScoreChange:asc" onSortChange={onSortChange} />,
    );
    expect(ascendingHost.querySelector('th[aria-sort="ascending"]')?.textContent).toContain(
      '30-day change',
    );
    const ascendingButton = Array.from(ascendingHost.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('30-day change'),
    );
    expect(ascendingButton?.getAttribute('aria-label')).toBe(
      'Sort by 30-day change. Current order: ascending. Activate to sort descending.',
    );
    await act(async () => ascendingButton?.click());
    expect(onSortChange).toHaveBeenCalledWith('riskScoreChange');
  });

  it('renders latest scan freshness and the explicit no-scan state in both layouts', async () => {
    const host = await render(
      <AssetsTable
        items={[
          {
            name: 'scanned.example.invalid',
            assetType: 'web',
            scanCount30d: 1,
            openCount: 1,
            unresolvedCount: 1,
            criticalCount: 0,
            highestUnresolvedSeverity: null,
            riskScore: 5,
            riskScoreChange: null,
            lastActivityAt: null,
            latestScanAt: '2026-09-15T12:30:00.000Z',
            latestScanStatus: 'completed',
          },
          {
            name: 'failed.example.invalid',
            assetType: 'web',
            scanCount30d: 0,
            openCount: 1,
            unresolvedCount: 1,
            criticalCount: 0,
            highestUnresolvedSeverity: null,
            riskScore: 5,
            riskScoreChange: null,
            lastActivityAt: null,
            latestScanAt: '2026-09-16T12:30:00.000Z',
            latestScanStatus: 'failed',
          },
          {
            name: 'unscanned.example.invalid',
            assetType: 'web',
            scanCount30d: 0,
            openCount: 0,
            unresolvedCount: 0,
            criticalCount: 0,
            highestUnresolvedSeverity: null,
            riskScore: null,
            riskScoreChange: null,
            lastActivityAt: null,
            latestScanAt: null,
            latestScanStatus: null,
          },
        ]}
        sort="openCount"
        onSortChange={vi.fn()}
      />,
    );

    expect(host.textContent).toContain('Latest scan:');
    expect(host.textContent?.match(/Completed/g)).toHaveLength(2);
    expect(host.textContent?.match(/Failed/g)).toHaveLength(2);
    expect(host.textContent).toContain('No scans recorded for this asset.');
    expect(host.querySelectorAll('time[dateTime="2026-09-15T12:30:00.000Z"]')).toHaveLength(2);
    expect(host.textContent?.match(/No scans recorded for this asset\./g)).toHaveLength(2);
  });
});
