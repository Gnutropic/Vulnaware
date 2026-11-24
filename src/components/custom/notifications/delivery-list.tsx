// @polsia:user-owned — Delivery-history table. Renders the last 5
// TeamNotificationDelivery rows for the caller's team. The parent re-fetches
// after every Save / Test, so this island is mostly a passive re-render.

'use client';

import { Loader2, Webhook } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { NotificationDeliveryItem } from '@/lib/contracts/team-notifications';

export interface NotificationDeliveryListProps {
  rows: NotificationDeliveryItem[] | null;
  loading?: boolean;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19);
}

export function NotificationDeliveryList({ rows, loading }: NotificationDeliveryListProps) {
  if (loading || rows === null) {
    return (
      <div className="flex items-center gap-2 rounded-[var(--radius-lg)] border border-border bg-card px-4 py-6 text-caption text-muted-foreground shadow-md">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading delivery history…
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-border bg-card shadow-md">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Attempted</TableHead>
            <TableHead>Alert</TableHead>
            <TableHead>Response</TableHead>
            <TableHead>Latency</TableHead>
            <TableHead>Error</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5}>
                <div className="flex items-center gap-2 px-2 py-6 text-caption text-muted-foreground">
                  <Webhook className="size-4" aria-hidden />
                  No deliveries yet — clicking <strong className="ml-1">Send test alert</strong>
                  or surfacing a real critical alert will populate this list.
                </div>
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => {
              const ok =
                row.responseCode != null && row.responseCode >= 200 && row.responseCode < 300;
              const variant: 'default' | 'destructive' | 'secondary' = ok
                ? 'default'
                : row.errorMessage
                  ? 'destructive'
                  : 'secondary';
              return (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-caption text-muted-foreground">
                    {formatTimestamp(row.attemptedAt)}
                  </TableCell>
                  <TableCell>
                    {row.alertId ? (
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-caption text-foreground">
                        {row.alertId}
                      </code>
                    ) : (
                      <span className="text-caption text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={variant}>{row.responseCode ?? '—'}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-caption text-foreground">
                    {row.latencyMs}ms
                  </TableCell>
                  <TableCell className="text-caption text-muted-foreground">
                    {row.errorMessage ?? '—'}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
