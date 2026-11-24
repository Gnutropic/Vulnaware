// @polsia:user-owned — Source-filter chip row for the /alerts page. Controlled
// component: the caller owns the active value and re-fires /api/alerts when it
// changes. Renders 4 chips: "All", then one per ScanSource enum value, using
// the existing Button primitive so we don't pull in a new shadcn component.
// Roles: each chip uses `aria-pressed` for screen-reader state and a visible
// brand-tinted background when active.

'use client';

import { Button } from '@/components/ui/button';
import type { ScanSource } from '@/lib/contracts/scan';
import { scanSourceOptions } from '@/lib/scan-source-labels';

export type SourceFilter = ScanSource | null;

interface AlertsSourceChipRowProps {
  value: SourceFilter;
  onChange: (next: SourceFilter) => void;
}

export function AlertsSourceChipRow({ value, onChange }: AlertsSourceChipRowProps) {
  const chips: ReadonlyArray<{ key: SourceFilter; label: string }> = [
    { key: null, label: 'All' },
    ...scanSourceOptions.map((opt) => ({ key: opt.value as SourceFilter, label: opt.label })),
  ];

  return (
    <fieldset
      aria-label="Filter alerts by trigger source"
      className="flex flex-wrap items-center gap-2 border-0 p-0 m-0"
    >
      {chips.map((chip) => {
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
