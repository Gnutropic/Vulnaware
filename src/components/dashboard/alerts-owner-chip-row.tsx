// @polsia:user-owned — Owner-filter chip row for the /alerts page.
// Controlled component: the caller owns the active value and re-fires
// /api/alerts when it changes. Renders a SINGLE toggleable chip
// ("Owned by me") using the existing Button primitive, mirroring
// alerts-severity-chip-row, alerts-status-chip-row, and
// alerts-source-chip-row so all four rows render as a single visual
// filter band.
//
// The wire key is `?ownedByMe=1` (boolean-flag literal, mirror of
// `?hideSnoozed=1`). The page reads it via
// `sp.get('ownedByMe') === '1'` and serializes back via `effectiveQs`'
// `ownedByMe` boolean field. `false` (the resting state) drops the
// key from the URL via `effectiveQs` so a chip click never silently
// drops text input state on the way back.

'use client';

import { Button } from '@/components/ui/button';

export type OwnedByMeFlag = boolean;

interface AlertsOwnerChipRowProps {
  value: OwnedByMeFlag;
  onChange: (next: OwnedByMeFlag) => void;
}

export function AlertsOwnerChipRow({ value, onChange }: AlertsOwnerChipRowProps) {
  return (
    <fieldset
      aria-label="Filter alerts by owner"
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
        Owned by me
      </Button>
    </fieldset>
  );
}
