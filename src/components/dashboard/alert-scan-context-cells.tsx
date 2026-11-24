// @polsia:user-owned — Latest scan details and the completed-context empty state.

import { Badge } from '@/components/ui/badge';
import { TableCell } from '@/components/ui/table';
import type { AlertDetail } from '@/lib/contracts/alerts';

interface AlertScanContextCellsProps {
  latestScanAt: string | null;
  latestScanStatus: AlertDetail['asset']['latestScanStatus'];
  hasCompletedScan: boolean;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleString();
}

function scanOutcomeVariant(
  status: NonNullable<AlertScanContextCellsProps['latestScanStatus']>,
): 'default' | 'destructive' | 'secondary' | 'outline' {
  if (status === 'completed') return 'default';
  if (status === 'failed') return 'destructive';
  if (status === 'running') return 'secondary';
  return 'outline';
}

export function AlertScanContextCells({
  latestScanAt,
  latestScanStatus,
  hasCompletedScan,
}: AlertScanContextCellsProps) {
  return (
    <>
      <TableCell className="hidden font-mono text-caption text-muted-foreground md:table-cell">
        {latestScanAt ? (
          <time dateTime={latestScanAt}>{formatTimestamp(latestScanAt)}</time>
        ) : (
          <span>No scan recorded</span>
        )}
      </TableCell>
      <TableCell className="hidden text-caption md:table-cell">
        <div className="flex flex-col items-start gap-1">
          {latestScanStatus ? (
            <Badge
              variant={scanOutcomeVariant(latestScanStatus)}
              className="font-mono text-caption uppercase tracking-wider"
            >
              {latestScanStatus}
            </Badge>
          ) : (
            <span className="text-muted-foreground">Unavailable</span>
          )}
          {!hasCompletedScan ? (
            <span className="text-muted-foreground">Completed scan context unavailable</span>
          ) : null}
        </div>
      </TableCell>
    </>
  );
}

export function AlertScanContextSummary({
  latestScanAt,
  latestScanStatus,
  hasCompletedScan,
}: AlertScanContextCellsProps) {
  return (
    <div className="mt-2 flex flex-col items-start gap-1 border-l-2 border-border pl-2 text-caption md:hidden">
      <span className="text-muted-foreground">Latest scan</span>
      {latestScanAt ? (
        <time className="font-mono text-muted-foreground" dateTime={latestScanAt}>
          {formatTimestamp(latestScanAt)}
        </time>
      ) : (
        <span className="text-muted-foreground">No scan recorded</span>
      )}
      {latestScanStatus ? (
        <Badge
          variant={scanOutcomeVariant(latestScanStatus)}
          className="font-mono text-caption uppercase tracking-wider"
        >
          {latestScanStatus}
        </Badge>
      ) : (
        <span className="text-muted-foreground">Scan status unavailable</span>
      )}
      {!hasCompletedScan ? (
        <span className="text-muted-foreground">Completed scan context unavailable</span>
      ) : null}
    </div>
  );
}
