// @polsia:user-owned — CSV Export module control for the /assets page.

'use client';

import { Download } from 'lucide-react';
import { CsvExporter } from '@/components/custom/csv-exporter';
import type { AssetSeverityFilter } from '@/components/dashboard/assets-severity-chip-row';
import type { AssetStatusFilter } from '@/components/dashboard/assets-status-chip-row';
import type {
  AssetAlertPresence,
  AssetRiskTrend,
  AssetScanRecency,
  AssetScanStatus,
  AssetSortKey,
} from '@/lib/contracts/assets';

interface AssetsExportButtonProps {
  q: string;
  severity: AssetSeverityFilter;
  status: AssetStatusFilter;
  minRiskScore: number | null;
  scanRecency: AssetScanRecency;
  latestScanStatus: AssetScanStatus | null;
  neverScanned: boolean;
  riskTrend: AssetRiskTrend | null;
  alertPresence: AssetAlertPresence;
  sort: AssetSortKey;
  disabled?: boolean;
}

export function AssetsExportButton({
  q,
  severity,
  status,
  minRiskScore,
  scanRecency,
  latestScanStatus,
  neverScanned,
  riskTrend,
  alertPresence,
  sort,
  disabled = false,
}: AssetsExportButtonProps) {
  const filters: Record<string, string> = { sort };
  if (q) filters.q = q;
  if (severity) filters.severity = severity;
  if (status) filters.status = status;
  if (minRiskScore !== null) filters.minRiskScore = String(minRiskScore);
  if (scanRecency !== 'all') filters.scanRecency = scanRecency;
  if (latestScanStatus) filters.latestScanStatus = latestScanStatus;
  if (neverScanned) filters.neverScanned = 'true';
  if (riskTrend) filters.riskTrend = riskTrend;
  if (alertPresence !== 'all') filters.alertPresence = alertPresence;

  return (
    <CsvExporter
      sourceId="vulnaware-assets"
      endpoint="/api/assets/export.csv"
      filters={filters}
      disabled={disabled}
      buttonVariant="outline"
      buttonSize="sm"
      label={
        <>
          <Download aria-hidden="true" className="mr-1.5 size-3.5" />
          Export CSV
        </>
      }
    />
  );
}
