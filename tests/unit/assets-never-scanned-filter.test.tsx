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

import { AssetsNeverScannedFilter } from '@/components/dashboard/assets-never-scanned-filter';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

describe('assets completed-scan filter', () => {
  it('offers a selectable Never scanned value and a clear action for an active selection', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const onChange = vi.fn();

    await act(async () => {
      root?.render(<AssetsNeverScannedFilter value onChange={onChange} />);
    });

    expect(container.textContent).toContain('Never scanned');
    await act(async () => {
      container?.querySelector<HTMLButtonElement>('button[data-value="all"]')?.click();
    });
    expect(onChange).toHaveBeenCalledWith(false);

    await act(async () => {
      container?.querySelector<HTMLButtonElement>('button[data-value="never"]')?.click();
    });
    expect(onChange).toHaveBeenCalledWith(true);

    await act(async () => {
      Array.from(container?.querySelectorAll('button') ?? [])
        .find((button) => button.textContent?.includes('Clear Never scanned filter'))
        ?.click();
    });
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
});
