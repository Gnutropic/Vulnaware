// @polsia:user-owned — CI/CD webhook trigger list island. Renders the last
// 20 WebhookTrigger rows for the caller's team, fetched via apiFetch +
// WebhookTriggerList contract. `'use client'` — never imports server-only
// modules. Status is mapped to Badge variants; algorithmic column uses an
// outline Badge.

'use client';

import { Loader2, Webhook } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiFetch } from '@/lib/api-client';
import {
  type WebhookTriggerItem as WebhookTriggerItemType,
  WebhookTriggerList,
  type WebhookTriggerStatus,
} from '@/lib/contracts/webhooks-triggers';

// Slice to date-time (yyyy-mm-ddThh:mm:ss) — full TS pushes neighbour
// columns off-page. ISO 8601 is sortable in scans/links anyway.
function formatReceivedAt(value: string): string {
  return new Date(value).toISOString().slice(0, 19);
}

function statusVariant(status: WebhookTriggerStatus): 'default' | 'secondary' | 'destructive' {
  if (status === 'completed') return 'default';
  if (status === 'failed') return 'destructive';
  return 'secondary';
}

function statusLabel(status: WebhookTriggerStatus): string {
  // Capitalize first letter for display.
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function CicdTriggerList() {
  const [items, setItems] = useState<WebhookTriggerItemType[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const list = await apiFetch('/api/v1/webhooks/triggers', {
        schema: WebhookTriggerList,
      });
      setItems(list.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load triggers');
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (items === null) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-caption text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading recent triggers…
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {error ? (
        <p className="text-caption text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="overflow-hidden rounded-[var(--radius-lg)] border border-border bg-card shadow-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Received</TableHead>
              <TableHead>Repository</TableHead>
              <TableHead>Build</TableHead>
              <TableHead>Branch</TableHead>
              <TableHead>Algorithm</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <div className="flex items-center gap-2 px-2 py-6 text-caption text-muted-foreground">
                    <Webhook className="size-4" aria-hidden />
                    No webhook triggers yet — wire a CI job to
                    <code className="ml-1 rounded bg-muted px-1.5 py-0.5 font-mono">
                      /api/v1/webhooks/trigger
                    </code>
                    to populate this list.
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-mono text-caption text-muted-foreground">
                    {formatReceivedAt(item.receivedAt)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-baseline gap-2">
                      <code className="max-w-[28rem] truncate rounded bg-muted px-1.5 py-0.5 font-mono text-caption text-foreground">
                        {item.repositoryUrl}
                      </code>
                      {item.repositoryRef ? (
                        <span className="font-mono text-caption text-muted-foreground">
                          {item.repositoryRef}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-caption text-muted-foreground">
                    {item.buildId ?? '—'}
                  </TableCell>
                  <TableCell className="font-mono text-caption text-muted-foreground">
                    {item.buildBranch ?? '—'}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{item.signatureAlgorithm}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(item.status)}>{statusLabel(item.status)}</Badge>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
