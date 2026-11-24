// @polsia:user-owned — Severity-filter chip row for the /assets page.
// Controlled component: the caller owns the active value and re-fires
// /api/assets when it changes. Renders 5 chips (`All` + Critical/High/Medium/
// Low) using the existing Button primitive — mirrors
// alerts-severity-chip-row exactly so the two rows render as a single
// visual filter band across the dashboard.

'use client';

import { Button } from '@/components/ui/button';
import type { AssetSeverity } from '@/lib/contracts/assets';

export type AssetSeverityFilter = AssetSeverity | null;

interface AssetsSeverityChipRowProps {
  value: AssetSeverityFilter;
  onChange: (next: AssetSeverityFilter) => void;
}

const SEVERITY_CHIPS: ReadonlyArray<{ key: AssetSeverityFilter; label: string }> = [
  { key: null, label: 'All' },
  { key: 'critical', label: 'Critical' },
  { key: 'high', label: 'High' },
  { key: 'medium', label: 'Medium' },
  { key: 'low', label: 'Low' },
];

export function AssetsSeverityChipRow({ value, onChange }: AssetsSeverityChipRowProps) {
  return (
    <fieldset
      aria-label="Filter assets by severity"
      className="flex flex-wrap items-center gap-2 border-0 p-0 m-0"
    >
      {SEVERITY_CHIPS.map((chip) => {
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
