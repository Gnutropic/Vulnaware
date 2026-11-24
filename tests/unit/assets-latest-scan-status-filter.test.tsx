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
    <span aria-label={ariaLabel}>{ariaLabel}</span>
  ),
}));

import { AssetsLatestScanStatusFilter } from '@/components/dashboard/assets-latest-scan-status-filter';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

async function render(value: 'all' | 'completed') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const onChange = vi.fn();
  await act(async () => {
    root?.render(
      <AssetsLatestScanStatusFilter
        value={value === 'all' ? null : value}
        onChange={onChange}
      />,
    );
  });
  return { host: container, onChange };
}

describe('assets latest scan status filter', () => {
  it('shows All and every scan status while reflecting the controlled selection', async () => {
    const { host } = await render('completed');

    expect(host?.textContent).toContain('All');
    expect(host?.textContent).toContain('Queued');
    expect(host?.textContent).toContain('Running');
    expect(host?.textContent).toContain('Completed');
    expect(host?.textContent).toContain('Failed');
    expect(host?.querySelector('[aria-labelledby="assets-latest-scan-status-label"]')?.textContent)
      .toContain('Completed');
  });

  it('reports a chosen status and lets All clear the filter', async () => {
    const { host, onChange } = await render('all');

    await act(async () => {
      host?.querySelector<HTMLButtonElement>('button[data-value="failed"]')?.click();
    });
    expect(onChange).toHaveBeenCalledWith('failed');

    await act(async () => {
      host?.querySelector<HTMLButtonElement>('button[data-value="all"]')?.click();
    });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});
