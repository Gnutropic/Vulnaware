// Single source of truth for user-facing labels of the Scan.source column.
// Imported by:
//   - src/app/api/alerts/route.ts (server-side, future use)
//   - src/components/dashboard/alerts-source-chip-row.tsx (filter chips)
//   - src/app/(dashboard)/alerts/page.tsx (per-row "Triggered by" badge)
// Future renames ("Scheduled" → "Recurring") happen here, once.

import type { ScanSource } from '@/lib/contracts/scan';

export const scanSourceLabels: Record<ScanSource, string> = {
  'ci-webhook': 'CI webhook',
  scheduled: 'Scheduled',
  manual: 'Manual',
};

export const scanSourceOptions: ReadonlyArray<{ value: ScanSource; label: string }> = [
  { value: 'ci-webhook', label: scanSourceLabels['ci-webhook'] },
  { value: 'scheduled', label: scanSourceLabels.scheduled },
  { value: 'manual', label: scanSourceLabels.manual },
];
