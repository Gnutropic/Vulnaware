// @polsia:user-owned — Authenticated byte download for an alert's remediation
// brief. The private alert route owns authorization and document contents;
// this island only turns a successful PDF response into a native download.

'use client';

import { Download, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

interface AlertsExportPdfButtonProps {
  alertId: string;
}

export function AlertsExportPdfButton({ alertId }: AlertsExportPdfButtonProps) {
  const [pending, setPending] = useState(false);

  async function handleDownload() {
    if (pending) return;
    setPending(true);

    try {
      const response = await fetch(`/api/alerts/${encodeURIComponent(alertId)}/pdf`, {
        credentials: 'same-origin',
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 404) {
          toast.error('This alert is not available for export.');
        } else {
          toast.error(`Export failed (HTTP ${response.status}).`);
        }
        return;
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `alert-${alertId}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Export failed — could not reach the server.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => {
        void handleDownload();
      }}
      disabled={pending}
      aria-disabled={pending}
      data-testid="alert-export-pdf-button"
    >
      {pending ? (
        <>
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Preparing…
        </>
      ) : (
        <>
          <Download className="size-4" aria-hidden />
          Download remediation brief (PDF)
        </>
      )}
    </Button>
  );
}
