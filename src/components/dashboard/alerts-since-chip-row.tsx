// @polsia:user-owned — Trailing-N-days chip row for the /alerts page
// (the brief's "Last 7 days" toggle). Controlled component: the caller
// owns the active value and re-fires /api/alerts when it changes.
// Renders TWO chips ("All" + "Last 7d") using the existing Button
// primitive, mirroring alerts-severity-chip-row exactly so this row
// blends with the surrounding chip band without visual drift.
//
// v1 ships a single "Last 7d" toggle; the schema enum is widened to
// ('7d','30d','90d') so adding a new chip key later doesn't reshape
// the wire contract — only this row's chip list grows in that case.
//
// Time zone: the bound is computed on the client via `sinceToBoundDate`
// from the chip's `now` (= `new Date()` at click time), so the window
// is whatever the user's local clock suggests. UTC floor semantics
// match the page's `<input type="date">` slices (which use the same
// client `new Date()`), so a freshly-mounted page and a freshly-clicked
// chip agree on what "Last 7d" means.
//
// The "All" chip maps to `null`, NOT the empty string — the /alerts
// page drops `since` from the URL on `null` via `effectiveQs`, the
// same posture the severity/owner rows already use.
//
// `SinceFilter` is the chip-side alias of the helper module's chip
// key — a single source of truth so the page's `useState<SinceFilter>`
// matches what this row's onChange callback emits.

'use client';

import { Button } from '@/components/ui/button';
import type { SinceFilter } from '@/lib/business/alerts-since';

export type { SinceFilter } from '@/lib/business/alerts-since';

interface AlertsSinceChipRowProps {
  value: SinceFilter;
  onChange: (next: SinceFilter) => void;
}

const SINCE_CHIPS: ReadonlyArray<{ key: SinceFilter; label: string }> = [
  { key: null, label: 'All' },
  { key: '7d', label: 'Last 7d' },
];

export function AlertsSinceChipRow({ value, onChange }: AlertsSinceChipRowProps) {
  return (
    <fieldset
      aria-label="Filter alerts by trailing days"
      className="flex flex-wrap items-center gap-2 border-0 p-0 m-0"
    >
      {SINCE_CHIPS.map((chip) => {
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
