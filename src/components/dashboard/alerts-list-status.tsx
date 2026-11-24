// @polsia:user-owned — Inline status editor shared by both /alerts list layouts.

'use client';

import { AlertStatusControl } from '@/components/custom/alert-status-control';
import type { AlertItem, AlertStatusMutationResponse } from '@/lib/contracts/alerts';

interface AlertsListStatusProps {
  item: Pick<AlertItem, 'id' | 'status' | 'falsePositiveReason' | 'closingNote'>;
  onSaved: (saved: AlertStatusMutationResponse) => void;
}

export function AlertsListStatus({ item, onSaved }: AlertsListStatusProps) {
  const detail =
    item.status === 'resolved'
      ? { label: 'Resolution note', value: item.closingNote }
      : item.status === 'false_positive'
        ? { label: 'Reason', value: item.falsePositiveReason }
        : null;

  return (
    <div className="min-w-36 space-y-1">
      <AlertStatusControl alertId={item.id} status={item.status} onSaved={onSaved} />
      {detail?.value ? (
        <p className="max-w-72 break-words text-caption text-muted-foreground" title={detail.value}>
          {detail.label}: {detail.value}
        </p>
      ) : null}
    </div>
  );
}
