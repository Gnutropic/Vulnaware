// @polsia:user-owned — Azure connection list island. Lists the user's Azure
// connections and exposes per-row Discover-now + Remove actions. Mirrors the
// AWS connection-list surface.

'use client';

import { Cloud, Loader2, Play, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  type AzureConnectionItem,
  AzureConnectionList,
  AzureDiscoveryCreateResponse,
} from '@/lib/contracts/azure';

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toISOString().slice(0, 10);
}

export function AzureConnectionListView() {
  const router = useRouter();

  const [items, setItems] = useState<AzureConnectionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const list = await apiFetch('/api/azure/connections', { schema: AzureConnectionList });
      setItems(list.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load connections');
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onDiscover = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        const res = await apiFetch('/api/azure/discover', {
          method: 'POST',
          body: JSON.stringify({ connectionId: id }),
          schema: AzureDiscoveryCreateResponse,
        });
        toast.success('Discovery queued — taking you to the run.');
        router.push(`/cloud/runs/${res.id}`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not queue discovery');
      } finally {
        setBusyId(null);
      }
    },
    [router],
  );

  const onDelete = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await apiFetch(`/api/azure/connections/${id}`, { method: 'DELETE' });
        toast.success('Connection removed.');
        await reload();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Delete failed');
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  if (items === null) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-caption text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading Azure connections…
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
              <TableHead>Label</TableHead>
              <TableHead>Subscription</TableHead>
              <TableHead>Tenant</TableHead>
              <TableHead>Locations</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-[12rem] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <div className="flex items-center gap-2 px-2 py-6 text-caption text-muted-foreground">
                    <Cloud className="size-4" aria-hidden /> No Azure connections yet — fill in the
                    form above.
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">{item.label}</TableCell>
                  <TableCell className="max-w-[14rem] truncate font-mono text-caption text-muted-foreground">
                    {item.subscriptionId}
                  </TableCell>
                  <TableCell className="max-w-[14rem] truncate font-mono text-caption text-muted-foreground">
                    {item.tenantId}
                  </TableCell>
                  <TableCell>
                    {item.locations.length === 0 ? (
                      <Badge variant="outline">default</Badge>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {item.locations.slice(0, 4).map((l) => (
                          <Badge key={l} variant="secondary">
                            {l}
                          </Badge>
                        ))}
                        {item.locations.length > 4 ? (
                          <Badge variant="outline">+{item.locations.length - 4}</Badge>
                        ) : null}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-caption text-muted-foreground">
                    {formatDate(item.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        type="button"
                        onClick={() => onDiscover(item.id)}
                        disabled={busyId === item.id}
                      >
                        {busyId === item.id ? (
                          <Loader2 className="size-4 animate-spin" aria-hidden />
                        ) : (
                          <Play className="size-4" aria-hidden />
                        )}
                        Discover now
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        type="button"
                        onClick={() => onDelete(item.id)}
                        disabled={busyId === item.id}
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    </div>
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
