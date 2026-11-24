// @polsia:user-owned
'use client';

import type { ComponentProps, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import type { CsvDelimiter } from '@/modules/csv-export/contracts';
import { exportResponseSchema } from '@/modules/csv-export/contracts';
import { csvExportErrorMessage, saveCsvFile } from '@/modules/csv-export/download';

export interface CsvExporterProps {
  sourceId: string;
  filters: unknown;
  endpoint?: string;
  columns?: string[];
  delimiter?: CsvDelimiter;
  label?: ReactNode;
  disabled?: boolean;
  buttonVariant?: ComponentProps<typeof Button>['variant'];
  buttonSize?: ComponentProps<typeof Button>['size'];
  buttonClassName?: string;
}

export function CsvExporter({
  sourceId,
  filters,
  endpoint = '/api/csv-export',
  columns,
  delimiter = ',',
  label = 'Exporter en CSV',
  disabled = false,
  buttonVariant,
  buttonSize,
  buttonClassName,
}: CsvExporterProps) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const active = useRef<AbortController | null>(null);
  const requestKey = JSON.stringify({ sourceId, filters, columns, delimiter });

  useEffect(() => {
    // Changing active filters/source invalidates an outstanding export.
    if (requestKey) {
      setStatus('idle');
      setMessage('');
    }
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [requestKey]);

  async function download() {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setStatus('loading');
    setMessage('');
    try {
      const result = await apiFetch(endpoint, {
        method: 'POST',
        body: JSON.stringify({ sourceId, filters, columns, delimiter }),
        signal: controller.signal,
        schema: exportResponseSchema,
      });
      if (controller.signal.aborted || active.current !== controller) return;
      saveCsvFile(result.data.csv, result.data.filename);
      setMessage(`${result.data.records.toLocaleString('fr-FR')} ligne(s) exportée(s).`);
      setStatus('success');
    } catch (error) {
      if (controller.signal.aborted || active.current !== controller) return;
      setMessage(csvExportErrorMessage(error));
      setStatus('error');
    } finally {
      if (active.current === controller) active.current = null;
    }
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        disabled={disabled || status === 'loading'}
        onClick={download}
        aria-busy={status === 'loading'}
        variant={buttonVariant}
        size={buttonSize}
        className={buttonClassName}
      >
        {status === 'loading' ? 'Export en cours…' : label}
      </Button>
      {message && (
        <p className="text-sm" role={status === 'error' ? 'alert' : 'status'}>
          {message}
        </p>
      )}
    </div>
  );
}
