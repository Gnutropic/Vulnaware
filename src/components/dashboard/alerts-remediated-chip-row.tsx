// @polsia:user-owned — Remediated-filter chip row for the /alerts page.
// Controlled component: the caller owns the active value and re-fires
// /api/alerts when it changes. Renders a SINGLE toggleable chip
// ("Remediated only") using the existing Button primitive, mirroring
// alerts-owner-chip-row so all filter rows render as a single visual
// filter band.
//
// The wire key is `?remediated=1` (boolean-flag literal, mirror of
// `?ownedByMe=1`). The page reads it via
// `sp.get('remediated') === '1'` and serializes back via `effectiveQs`'
// `remediatedOnly` boolean field. `false` (the resting state) drops the
// key from the URL via `effectiveQs` so a chip click never silently
// drops text input state on the way back.

'use client';

import { Button } from '@/components/ui/button';

export type RemediatedOnlyFlag = boolean;

interface AlertsRemediatedChipRowProps {
  value: RemediatedOnlyFlag;
  onChange: (next: RemediatedOnlyFlag) => void;
}

export function AlertsRemediatedChipRow({ value, onChange }: AlertsRemediatedChipRowProps) {
  return (
    <fieldset
      aria-label="Filter alerts by remediation"
      className="flex flex-wrap items-center gap-2 border-0 p-0 m-0"
    >
      <Button
        type="button"
        size="sm"
        variant={value ? 'default' : 'outline'}
        aria-pressed={value}
        data-active={value}
        onClick={() => onChange(!value)}
        className="min-h-11 rounded-full px-4 md:min-h-0 md:px-3"
      >
        Remediated only
      </Button>
    </fieldset>
  );
}
