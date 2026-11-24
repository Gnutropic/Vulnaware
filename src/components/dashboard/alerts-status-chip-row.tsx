// @polsia:user-owned — Status-filter chip row for the /alerts page.
// Controlled URL-backed filter for the complete workflow status set.
// `snoozed` is derived from an active snooze window by the API; the
// other status values map to stored workflow states.

'use client';

import { Button } from '@/components/ui/button';

export type StatusFilter =
  | 'open'
  | 'in_progress'
  | 'resolved'
  | 'false_positive'
  | 'snoozed'
  | null;

interface AlertsStatusChipRowProps {
  value: StatusFilter;
  onChange: (next: StatusFilter) => void;
  includeOpen?: boolean;
}

const STATUS_CHIPS: ReadonlyArray<{ key: StatusFilter; label: string }> = [
  { key: null, label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'false_positive', label: 'False Positive' },
  { key: 'snoozed', label: 'Snoozed' },
];

export function AlertsStatusChipRow({
  value,
  onChange,
  includeOpen = false,
}: AlertsStatusChipRowProps) {
  const chips = includeOpen ? STATUS_CHIPS : STATUS_CHIPS.filter((chip) => chip.key !== 'open');
  return (
    <fieldset
      aria-label="Filter alerts by status"
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
