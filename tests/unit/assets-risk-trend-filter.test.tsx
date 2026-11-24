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
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => {
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

import { AssetsRiskTrendFilter } from '@/components/dashboard/assets-risk-trend-filter';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

async function render(value: 'all' | 'rising') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const onChange = vi.fn();
  await act(async () => {
    root?.render(<AssetsRiskTrendFilter value={value} onChange={onChange} />);
  });
  return { host: container, onChange };
}

describe('assets risk trend filter', () => {
  it('shows all trend choices and reports a controlled selection', async () => {
    const { host, onChange } = await render('all');

    expect(host?.textContent).toContain('All risk trends');
    expect(host?.textContent).toContain('Rising');
    expect(host?.textContent).toContain('Falling');
    expect(host?.textContent).toContain('Unchanged');

    await act(async () => {
      host?.querySelector<HTMLButtonElement>('button[data-value="rising"]')?.click();
    });
    expect(onChange).toHaveBeenCalledWith('rising');
  });

  it('shows a clear action only for an active selection', async () => {
    const { host, onChange } = await render('rising');
    const clear = Array.from(host?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes('Clear risk trend filter'),
    );

    expect(clear).not.toBeUndefined();
    await act(async () => clear?.click());
    expect(onChange).toHaveBeenCalledWith('all');
  });
});
