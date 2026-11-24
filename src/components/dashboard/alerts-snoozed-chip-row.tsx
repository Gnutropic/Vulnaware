// @polsia:user-owned — Snoozed-filter chip row for the /alerts page.
// Controlled component: the caller owns the active value and re-fires
// /api/alerts when it changes. Renders a SINGLE toggleable chip
// ("Snoozed only") using the existing Button primitive, mirroring
// alerts-owner-chip-row so all filter rows render as a single visual
// filter band.
//
// The wire key is `?snoozed=1` (boolean-flag literal, mirror of
// `?ownedByMe=1` / `?remediated=1`). The page reads it via
// `sp.get('snoozed') === '1'` and serializes back via `effectiveQs`'
// `snoozedOnly` boolean field. `false` (the resting state) drops the
// key from the URL via `effectiveQs` so a chip click never silently
// drops text input state on the way back.
//
// The narrowing semantic is `snoozedUntil > now` — i.e. "rows with an
// ACTIVE snooze window still in the future". This matches the
// bulk-resolve helper `alerts-bulk-resolve.ts` and the claim route
// `/api/alerts/[id]/claim/route.ts` "exclude future snoozes" posture
// verbatim (both use `gt` not `gte` on `snoozedUntil`), so a chip
// toggle surfaces exactly the rows a snooze stamp would hold back from
// the bulk-resolve working set.
//
// Active-state coloring rides `SNOOZED_COLOR_TOKEN.chipActive` from
// `@/lib/ui/severity-colors` (sister to the per-severity tokens the
// `AlertsSeverityChipRow` already uses) — painted into the chip's
// `className` rather than the shadcn `default` variant's
// `bg-primary`, so the brand token wins elsewhere. `variant` stays
// `outline` always; the chip's active visual flows from the token's
// `chipActive` class fragments instead of `default`. This keeps the
// chip and the count badge in `AlertsCountBadges` reading as the same
// color band (the latter paints `SNOOZED_COLOR_TOKEN.countText` on its
// count number). The chip + badge lockstep is the same invariant the
// per-severity tokens already pin for the dashboard tile, just with a
// different surface today.

'use client';

import { Button } from '@/components/ui/button';
import { SNOOZED_COLOR_TOKEN } from '@/lib/ui/severity-colors';

export type SnoozedOnlyFlag = boolean;

interface AlertsSnoozedChipRowProps {
  value: SnoozedOnlyFlag;
  onChange: (next: SnoozedOnlyFlag) => void;
}

export function AlertsSnoozedChipRow({ value, onChange }: AlertsSnoozedChipRowProps) {
  return (
    <fieldset
      aria-label="Filter alerts by snooze status"
      className="flex flex-wrap items-center gap-2 border-0 p-0 m-0"
    >
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-pressed={value}
        data-active={value}
        onClick={() => onChange(!value)}
        className={`min-h-11 rounded-full px-4 md:min-h-0 md:px-3${value ? ` ${SNOOZED_COLOR_TOKEN.chipActive}` : ''}`}
      >
        Snoozed only
      </Button>
    </fieldset>
  );
}
