// @polsia:user-owned — Resolved-filter chip row for the /alerts page.
// Controlled component: the caller owns the active value and re-fires
// /api/alerts when it changes. Renders one toggleable "Resolved" chip
// using the existing Button primitive. It is the only Resolved control
// on /alerts; other consumers can retain the Resolved option in
// AlertsStatusChipRow. The existing ?status=resolved value composes
// with independent filters such as owner, severity, search, dates, and sort.

'use client';

import { Button } from '@/components/ui/button';

export type ResolvedOnlyFlag = boolean;

interface AlertsResolvedChipRowProps {
  value: ResolvedOnlyFlag;
  onChange: (next: ResolvedOnlyFlag) => void;
}

export function AlertsResolvedChipRow({ value, onChange }: AlertsResolvedChipRowProps) {
  return (
    <fieldset
      aria-label="Filter alerts by resolved status"
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
        Resolved
      </Button>
    </fieldset>
  );
}
