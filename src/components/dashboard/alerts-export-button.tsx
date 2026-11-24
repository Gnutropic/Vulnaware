// @polsia:user-owned
'use client';

import { Download } from 'lucide-react';
import { CsvExporter } from '@/components/custom/csv-exporter';
import { buildAlertsExportFilters } from '@/lib/business/alerts-export-filters';

interface AlertsExportButtonProps {
  search: string;
  disabled?: boolean;
}

export function AlertsExportButton({ search, disabled = false }: AlertsExportButtonProps) {
  const filters = buildAlertsExportFilters(search);

  return (
    <CsvExporter
      sourceId="vulnaware-alerts"
      endpoint="/api/alerts/export.csv"
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
