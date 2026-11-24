// @vitest-environment jsdom

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

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

import { AssetsMinRiskScoreFilter } from '@/components/dashboard/assets-min-risk-score-filter';
import { AssetsTable } from '@/components/dashboard/assets-table';

const { useRouter, useSearchParams } = await import('next/navigation');

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function setSearchParams(qs: string) {
  const params = new URLSearchParams(qs);
  (useSearchParams as unknown as ReturnType<typeof vi.fn>).mockReturnValue(params);
  window.history.replaceState(null, '', `/assets${qs ? `?${qs}` : ''}`);
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
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

describe('asset minimum risk score filter', () => {
  beforeEach(() => {
    setSearchParams(
      'q=api.example.invalid&severity=high&status=open&sort=riskScore&page=2&pageSize=10&minRiskScore=5',
    );
  });

  it('initializes from the URL and preserves every other list key when changing the threshold', async () => {
    const replace = makeRouter();
    const onChange = vi.fn();
    const host = await render(<AssetsMinRiskScoreFilter value={5} onChange={onChange} />);
    const input = host.querySelector<HTMLInputElement>('#assets-min-risk-score');

    expect(input?.value).toBe('5');
    if (!input) throw new Error('expected minimum risk score input');
    await act(async () => setNativeInputValue(input, '7.5'));

    expect(onChange).toHaveBeenCalledWith(7.5);
    expect(replace).toHaveBeenCalledWith(
      '/assets?q=api.example.invalid&severity=high&status=open&sort=riskScore&page=2&pageSize=10&minRiskScore=7.5',
      { scroll: false },
    );
  });

  it('clears only the threshold key and keeps the rest of the URL intact', async () => {
    const replace = makeRouter();
    const host = await render(<AssetsMinRiskScoreFilter value={5} onChange={vi.fn()} />);
    const input = host.querySelector<HTMLInputElement>('#assets-min-risk-score');

    if (!input) throw new Error('expected minimum risk score input');
    await act(async () => setNativeInputValue(input, ''));

    expect(replace).toHaveBeenCalledWith(
      '/assets?q=api.example.invalid&severity=high&status=open&sort=riskScore&page=2&pageSize=10',
      { scroll: false },
    );
  });

  it('explains a threshold-specific empty inventory and provides a clear link', async () => {
    const host = await render(
      <AssetsTable
        items={[]}
        sort="openCount"
        onSortChange={vi.fn()}
        minRiskScore={7.5}
        clearMinRiskScoreHref="/assets?q=api.example.invalid"
      />,
    );

    expect(host.textContent).toContain(
      'No assets with a risk score of at least 7.5 were found in the active workspace.',
    );
    expect(host.querySelector('a[href="/assets?q=api.example.invalid"]')?.textContent).toBe(
      'Clear minimum risk score',
    );
  });
});
