// @polsia:user-owned — High-level resolution filter row for /alerts.

'use client';

import { Button } from '@/components/ui/button';
import type { ResolutionFilter } from '@/lib/contracts/alerts';

const RESOLUTION_CHIPS: ReadonlyArray<{ key: ResolutionFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'unresolved', label: 'Unresolved' },
  { key: 'resolved', label: 'Resolved' },
];

interface AlertsResolutionChipRowProps {
  value: ResolutionFilter;
  onChange: (next: ResolutionFilter) => void;
}

export function AlertsResolutionChipRow({ value, onChange }: AlertsResolutionChipRowProps) {
  return (
    <fieldset
      aria-label="Filter alerts by resolution status"
      className="flex flex-wrap items-center gap-2 border-0 p-0 m-0"
    >
      {RESOLUTION_CHIPS.map((chip) => {
        const isActive = value === chip.key;
        return (
          <Button
            key={chip.key}
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
