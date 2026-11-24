// @polsia:user-owned — Connection list island. Lists the user's AWS
// connections and exposes per-row Test + Discover-now + Remove actions. Test
// and Discover-now hit /api/aws/connections/[id]/test and /api/aws/discover
// and surface toast feedback; the run id is returned to the caller so the
// detail view can poll it. On Discover-now this island ALSO pushes the
// /cloud/runs/[id] URL so the operator is taken straight to the polling view
// (per the data-plane invariant — the JS event handler is the only place
// where the navigation decision lives).

'use client';

import { Cloud, Loader2, Play, TestTube2, Trash2 } from 'lucide-react';
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
  type AwsConnectionItem,
  AwsConnectionList,
  AwsDiscoveryCreateResponse,
  AwsTestConnectionResponse,
} from '@/lib/contracts/aws';

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toISOString().slice(0, 10);
}

export function AwsConnectionListView() {
  const router = useRouter();

  const [items, setItems] = useState<AwsConnectionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const list = await apiFetch('/api/aws/connections', { schema: AwsConnectionList });
      setItems(list.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load connections');
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onTest = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        const res = await apiFetch(`/api/aws/connections/${id}/test`, {
          method: 'POST',
          schema: AwsTestConnectionResponse,
        });
        if (res.ok) {
          toast.success(
            `STS AssumeRole OK — account ${res.accountId ?? 'unknown'}, ${res.reachableRegions.length} reachable region(s).`,
          );
          await reload();
        } else {
          toast.error(`STS AssumeRole failed: ${res.errorMessage ?? 'unspecified error'}`);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Test failed');
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  const onDiscover = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        const res = await apiFetch('/api/aws/discover', {
          method: 'POST',
          body: JSON.stringify({ connectionId: id }),
          schema: AwsDiscoveryCreateResponse,
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
        await apiFetch(`/api/aws/connections/${id}`, { method: 'DELETE' });
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
        Loading AWS connections…
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
              <TableHead>Role ARN</TableHead>
              <TableHead>Regions</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last tested</TableHead>
              <TableHead className="w-[16rem] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <div className="flex items-center gap-2 px-2 py-6 text-caption text-muted-foreground">
                    <Cloud className="size-4" aria-hidden />
                    No AWS connections yet — paste a role ARN above to add one.
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">{item.label}</TableCell>
                  <TableCell className="max-w-[18rem] truncate font-mono text-caption text-muted-foreground">
                    {item.roleArn}
                  </TableCell>
                  <TableCell>
                    {item.regions.length === 0 ? (
                      <Badge variant="outline">default</Badge>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {item.regions.slice(0, 4).map((r) => (
                          <Badge key={r} variant="secondary">
                            {r}
                          </Badge>
                        ))}
                        {item.regions.length > 4 ? (
                          <Badge variant="outline">+{item.regions.length - 4}</Badge>
                        ) : null}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-caption text-muted-foreground">
                    {formatDate(item.createdAt)}
                  </TableCell>
                  <TableCell className="font-mono text-caption text-muted-foreground">
                    {formatDate(item.lastTestedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        type="button"
                        onClick={() => onTest(item.id)}
                        disabled={busyId === item.id}
                      >
                        {busyId === item.id ? (
                          <Loader2 className="size-4 animate-spin" aria-hidden />
                        ) : (
                          <TestTube2 className="size-4" aria-hidden />
                        )}
                        Test
                      </Button>
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
