// @polsia:user-owned — Open-filter chip row for the /alerts page.
// Controlled component: the caller owns the active value and re-fires
// /api/alerts when it changes. Renders a SINGLE toggleable chip
// ("Open only") using the existing Button primitive, mirroring
// alerts-snoozed-chip-row / alerts-owner-chip-row so all four
// boolean-flag rows render as a single visual filter band.
//
// Wire-key collision NOTE:
// The wire key here is `?status=open` — the LITERAL string `'open'`,
// NOT the boolean-flag literal `'1'` the rest of the boolean-flag
// family uses (snoozed=1 / ownedByMe=1 / remediated=1). This is a
// deliberate departure because `AlertQuery.status` is a `z.enum`
// whose first arm is already the literal `'open'`, so reusing the
// `?snoozed=1` family would require a fresh URL key (e.g.
// `?openOnly=1`) which would break the brief's "complete the status
// chip set" criterion — the shareable URL must still spell
// `?status=open` so it round-trips with the enum chip's old wire
// shape at the cost of a mutex.
//
// The collision is resolved three ways:
//   1. `AlertsStatusChipRow`'s `Open` chip is REMOVED (the enum row
//      drops to All / In Progress / Resolved / False Positive) so
//      no other chip writes `?status=open`.
//   2. `parseFiltersFromParams` reads `?status=open` OUTSIDE the
//      AlertQuery zod parse and STRIPS `status` from the enum's
//      input, so the literal `'open'` doesn't ALSO propagate through
//      the enum chip's writer on a permalink.
//   3. The route hard-rejects any `?status=` value other than the
//      literal `'open'` (the enum's `in_progress | resolved |
//      false_positive` values are unchanged — the enum chip still
//      emits those).
//
// The boolean-flag writer in `buildEffectiveQs` has
// `openOnly > status` precedence — when `openOnly` is true the
// writer emits `?status=open` and SKIPS the enum's writer line.
// When `openOnly` is false (the resting state) the enum's writer
// runs unchanged so `status=in_progress|resolved|false_positive`
// round-trips verbatim.
//
// The page-level mutex (the four boolean-flag chip rows clear each
// other on toggle-on) keeps the four filters mutually exclusive:
// Owned by me / Remediated only / Snoozed only / Open only — only
// ONE of those can be active at any one time. The enum chip row's
// `in_progress|resolved|false_positive` writes are NOT cleared by
// that mutex — those compose alongside any single boolean-flag
// active (e.g. `?status=in_progress&ownedByMe=1`).

'use client';

import { Button } from '@/components/ui/button';

export type OpenOnlyFlag = boolean;

interface AlertsOpenChipRowProps {
  value: OpenOnlyFlag;
  onChange: (next: OpenOnlyFlag) => void;
}

export function AlertsOpenChipRow({ value, onChange }: AlertsOpenChipRowProps) {
  return (
    <fieldset
      aria-label="Filter alerts by open status"
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
        Open only
      </Button>
    </fieldset>
  );
}
