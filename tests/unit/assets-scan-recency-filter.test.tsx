// @vitest-environment jsdom

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { act, createContext, useContext } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type SelectContextValue = { onValueChange: (value: string) => void };
const SelectContext = createContext<SelectContextValue>({ onValueChange: () => undefined });

vi.mock('@/components/ui/select', () => ({
  Select: ({
    children,
    onValueChange,
  }: {
    children: React.ReactNode;
    onValueChange: (value: string) => void;
    value: string;
  }) => <SelectContext.Provider value={{ onValueChange }}>{children}</SelectContext.Provider>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({
    children,
    value,
  }: {
    children: React.ReactNode;
    value: string;
  }) => {
    const { onValueChange } = useContext(SelectContext);
    return (
      <button type="button" data-value={value} onClick={() => onValueChange(value)}>
        {children}
      </button>
    );
  },
  SelectLabel: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  SelectTrigger: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SelectValue: ({ 'aria-label': ariaLabel }: { 'aria-label'?: string }) => (
    <span>{ariaLabel}</span>
  ),
}));

import { AssetsScanRecencyFilter } from '@/components/dashboard/assets-scan-recency-filter';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

async function render(value: 'all' | 'last7d' | 'noRecent30d') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const onChange = vi.fn();
  await act(async () => {
    root?.render(<AssetsScanRecencyFilter value={value} onChange={onChange} />);
  });
  return { host: container, onChange };
}

describe('assets scan recency filter', () => {
  it('shows all seven choices and reports a controlled selection', async () => {
    const { host, onChange } = await render('all');

    expect(host?.textContent).toContain('All scan history');
    expect(host?.textContent).toContain('Scanned in the last 24 hours');
    expect(host?.textContent).toContain('Scanned in the last 7 days');
    expect(host?.textContent).toContain('Scanned in the past 30 days');
    expect(host?.textContent).toContain('No scans in the past 30 days');
    expect(host?.textContent).toContain('Stale (more than 30 days)');
    expect(host?.textContent).toContain('No scan history');

    await act(async () => {
      host?.querySelector<HTMLButtonElement>('button[data-value="noRecent30d"]')?.click();
    });
    expect(onChange).toHaveBeenCalledWith('noRecent30d');
  });

  it('shows a clear action only for an active selection', async () => {
    const { host, onChange } = await render('noRecent30d');
    const clear = Array.from(host?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes('Clear scan recency filter'),
    );

    expect(clear).not.toBeUndefined();
    await act(async () => clear?.click());
    expect(onChange).toHaveBeenCalledWith('all');
  });
});
