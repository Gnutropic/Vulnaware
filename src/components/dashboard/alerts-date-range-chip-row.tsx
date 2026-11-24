// @polsia:user-owned — Date-range preset chip row for the /alerts page.
// Controlled component: the caller owns the active value and re-fires
// /api/alerts when it changes. Renders 4 chips ("All" + Last 7d / Last
// 30d / Last 90d) using the existing Button primitive so we don't pull
// in a new shadcn component. Mirrors alerts-severity-chip-row,
// alerts-status-chip-row, and alerts-source-chip-row so all four rows
// render as a single visual filter band.
//
// URL writer lives in the parent page (alerts/page.tsx), NOT here:
// the chip just lifts the chosen preset via `onChange` and lets the
// page decide what to write. This keeps a single URL writer.
//
// `aria-pressed` carries the screen-reader state; the active chip uses
// the `default` brand-tinted variant so the row reads as a "tab strip"
// without the cost of a new shadcn primitive.

'use client';

import { Button } from '@/components/ui/button';

export type DateRangePreset = '7d' | '30d' | '90d' | null;

interface AlertsDateRangeChipRowProps {
  value: DateRangePreset;
  onChange: (next: DateRangePreset) => void;
}

const PRESET_CHIPS: ReadonlyArray<{ key: DateRangePreset; label: string }> = [
  { key: null, label: 'All' },
  { key: '7d', label: 'Last 7d' },
  { key: '30d', label: 'Last 30d' },
  { key: '90d', label: 'Last 90d' },
];

export function AlertsDateRangeChipRow({ value, onChange }: AlertsDateRangeChipRowProps) {
  return (
    <fieldset
      aria-label="Filter alerts by date range"
      className="flex flex-wrap items-center gap-2 border-0 p-0 m-0"
    >
      {PRESET_CHIPS.map((chip) => {
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
