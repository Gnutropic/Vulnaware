// @polsia:user-owned — Reconcile list rows from the authoritative status mutation response.

import type { AlertItem, AlertStatusMutationResponse } from '@/lib/contracts/alerts';

export function applyAlertStatusMutation(
  items: AlertItem[],
  saved: AlertStatusMutationResponse,
): AlertItem[] {
  return items.map((item) =>
    item.id === saved.id
      ? {
          ...item,
          status: saved.status,
          acknowledgedAt: saved.acknowledgedAt,
          snoozedUntil: saved.snoozedUntil,
          falsePositiveReason: saved.falsePositiveReason,
          closingNote: saved.closingNote,
        }
      : item,
  );
}
