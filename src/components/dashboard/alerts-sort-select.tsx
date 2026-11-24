// @polsia:user-owned — Sort selector for the /alerts toolbar. Controlled
// client island that wraps the existing Radix-based @/components/ui/select
// (shadcn primitive). Mirrors the chip rows' visual contract
// (`min-h-11 rounded-full` outline-trigger) so the toolbar band reads as
// one block and the chip-active state stays brand-tinted via the existing
// native tokens. Controlled-only — `value` comes from the parent, every
// selection calls `onChange`, no internal state.
//
// Six options, in priority order:
//   1. `severity`            — critical → high → medium → low → null
//                              sink, ties by hostname ascending, then
//                              alert ID ascending. The server sort in
//                              /api/alerts/route.ts agrees; on the
//                              severity branch the server re-ranks
//                              the page slice in-app via
//                              compareAlertsBySort so the visible
//                              table and the CSV export are 1:1.
//   2. `severity:asc`        — low → medium → high → critical →
//                              null/unknown, with the same hostname/ID
//                              tiebreaks. URL emit form is
//                              `severity_asc`.
//   3. `lastActivity`        — sorts by the per-row derived
//                              `lastActivityAt ?? createdAt`
//                              (helper's two-arm derivation:
//                              noteMax OR remediatedAt; returns null
//                              on neither) DESC, ties on createdAt
//                              desc then id desc. SQL cursor stays
//                              monotone `createdAt desc + id desc`
//                              (the derived column has no Prisma
//                              `orderBy` literal); the in-app
//                              comparator re-ranks the page slice /
//                              CSV buffer so the visible table and
//                              the CSV export read in lockstep.
//                              **This is the default** (per the
//                              brief: align with the "Last
//                              activity" column the toolbar
//                              shows). On the URL it's emitted as
//                              `?sort=last_activity` (snake_case
//                              per the brief's literal wire naming).
//   4. `lastActivity:asc`    — same rank key as `lastActivity` but
//                              ASCENDED. Tied to the dropdown's
//                              "Last activity (Oldest first)" option.
//                              URL emit form is
//                              `last_activity_asc`.
//   5. `created`             — `createdAt desc` (the dropdown label
//                              is "Created (most recent first)").
//                              Same SQL cursor as `lastActivity`
//                              (Prisma-native `createdAt desc`), so
//                              the comparator and the export cursor
//                              agree rank-for-rank. The legacy
//                              `?sort=newest` URL alias resolves
//                              to this key on the schema transform,
//                              so a bookmarked visitor lands here
//                              cleanly.
//   6. `created:asc`         — `createdAt asc`. Tied to the
//                              dropdown's "Created (Oldest first)"
//                              option. URL emit form is
//                              `created_asc`.
//
// The wire schema in src/lib/contracts/alerts.ts keeps the legacy
// `status` arm so older shared URLs like ?sort=status still 200 —
// they fall through to the `lastActivity` selection because it is
// the resting default and no longer rendered as a dropdown option.

'use client';

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { AlertSortKey } from '@/lib/contracts/alerts';

interface AlertsSortSelectProps {
  value: AlertSortKey;
  onChange: (next: AlertSortKey) => void;
}

const OPTIONS: ReadonlyArray<{ key: AlertSortKey; label: string }> = [
  { key: 'severity', label: 'Severity (critical to low)' },
  { key: 'severity:asc', label: 'Severity (low to critical)' },
  { key: 'riskScore', label: 'Asset risk score (highest first)' },
  { key: 'riskScore:asc', label: 'Asset risk score (lowest first)' },
  { key: 'lastActivity', label: 'Last activity (most recent first)' },
  { key: 'lastActivity:asc', label: 'Last activity (oldest first)' },
  { key: 'created', label: 'Created (most recent first)' },
  { key: 'created:asc', label: 'Created (oldest first)' },
];

export function AlertsSortSelect({ value, onChange }: AlertsSortSelectProps) {
  return (
    <Select value={value} onValueChange={(next: string) => onChange(next as AlertSortKey)}>
      <SelectTrigger
        type="button"
        aria-label="Sort alerts"
        // Match the chip rows so the band reads as one block: same
        // min-h-11 / rounded-full / outline-trigger affordance as
        // <AlertsSeverityChipRow> etc. brand-active visual comes from
        // the trigger's `data-active` outline color in dark mode via the
        // existing tokens (no new color needed).
        className="min-h-11 rounded-full border-input px-4 text-left md:min-h-0 md:px-3"
      >
        <SelectValue aria-label="Sort alerts" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Sort</SelectLabel>
          {OPTIONS.map((opt) => (
            <SelectItem key={opt.key} value={opt.key} className="rounded-md">
              {opt.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
