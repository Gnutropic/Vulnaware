// @polsia:user-owned — Status-filter chip row for the /assets page. Mirrors
// alerts-status-chip-row so the chip semantics read the same way: "All" +
// Open / In Progress / Resolved. The brief's headline is "total open
// alerts" so Open is the operator's default mental model; an explicit
// status chip row lets them confirm the rollup accounting matches their
// click-by-click intuition.

'use client';

import { Button } from '@/components/ui/button';

export type AssetStatusFilter = 'open' | 'in_progress' | 'resolved' | null;

interface AssetsStatusChipRowProps {
  value: AssetStatusFilter;
  onChange: (next: AssetStatusFilter) => void;
}

const STATUS_CHIPS: ReadonlyArray<{ key: AssetStatusFilter; label: string }> = [
  { key: null, label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'resolved', label: 'Resolved' },
];

export function AssetsStatusChipRow({ value, onChange }: AssetsStatusChipRowProps) {
  return (
    <fieldset
      aria-label="Filter assets by status"
      className="flex flex-wrap items-center gap-2 border-0 p-0 m-0"
    >
      {STATUS_CHIPS.map((chip) => {
        const isActive = value === chip.key;
        return (
          <Button
            key={chip.key ?? 'all'}
            type="button"
            size="sm"
            variant={isActive ? 'default' : 'outline'}
            aria-pressed={isActive}
            data-active={isActive}
            onClick={() => onChange(chip.key)}
            className="min-h-11 rounded-full px-4 md:min-h-0 md:px-3"
          >
            {chip.label}
          </Button>
        );
      })}
    </fieldset>
  );
}
