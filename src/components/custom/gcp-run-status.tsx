// @polsia:user-owned — GCP run-status poll island. Polls /api/gcp/discover/[id]
// while the run is queued/running and renders the asset table once succeeded.

'use client';

import { Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { GcpAssetTable } from '@/components/custom/gcp-asset-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import {
  type GcpDiscoveryRunWithAssets,
  GcpDiscoveryRunWithAssets as RunSchema,
} from '@/lib/contracts/gcp';

const POLL_INTERVAL_MS = 2_000;

export function GcpRunStatus({ runId }: { runId: string }) {
  const [run, setRun] = useState<GcpDiscoveryRunWithAssets | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let interval: ReturnType<typeof setInterval> | null = null;

    async function load() {
      try {
        const next = await apiFetch(`/api/gcp/discover/${runId}`, { schema: RunSchema });
        if (!active) return;
        setRun(next);
        if (next.status === 'queued' || next.status === 'running') {
          interval ??= setInterval(() => void load(), POLL_INTERVAL_MS);
        } else if (interval) {
          clearInterval(interval);
          interval = null;
        }
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Failed to load run');
      }
    }

    void load();
    return () => {
      active = false;
      if (interval) clearInterval(interval);
    };
  }, [runId]);

  if (error) {
    return (
      <div
        className="rounded-[var(--radius)] border border-destructive/30 bg-destructive/5 px-4 py-3 text-caption text-destructive"
        role="alert"
      >
        {error}
      </div>
    );
  }

  if (!run) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-caption text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading run…
      </div>
    );
  }

  const terminal = run.status === 'succeeded' || run.status === 'failed';

  return (
    <div className="grid gap-6">
      <header className="grid gap-2 rounded-[var(--radius-lg)] border border-border bg-card p-5 shadow-md">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-h4 text-foreground">Run {run.id.slice(0, 12)}</h3>
          <Badge
            variant={
              run.status === 'failed'
                ? 'destructive'
                : run.status === 'succeeded'
                  ? 'secondary'
                  : 'outline'
            }
          >
            {run.status}
          </Badge>
          {run.projectId ? <Badge variant="outline">project {run.projectId}</Badge> : null}
          {run.zones.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {run.zones.slice(0, 4).map((z) => (
                <Badge key={z} variant="secondary">
                  {z}
                </Badge>
              ))}
              {run.zones.length > 4 ? (
                <Badge variant="outline">+{run.zones.length - 4}</Badge>
              ) : null}
            </div>
          ) : null}
        </div>
        <p className="text-caption text-muted-foreground">
          Started {new Date(run.startedAt).toLocaleString()}
          {run.finishedAt ? ` · finished ${new Date(run.finishedAt).toLocaleString()}` : ''}
          {run.resourcesTotal ? ` · ${run.resourcesTotal} resource(s)` : ''}
        </p>
        {run.status === 'failed' && run.errorMessage ? (
          <p className="text-caption text-destructive" role="alert">
            {run.errorMessage}
          </p>
        ) : null}
        {!terminal ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-fit"
            onClick={() => window.location.reload()}
          >
            <RefreshCw className="size-4" aria-hidden /> Refresh
          </Button>
        ) : null}
      </header>

      {terminal && run.status === 'succeeded' ? (
        <section className="grid gap-2">
          <h4 className="text-h4 text-foreground">Discovered assets</h4>
          <GcpAssetTable assets={run.assets} />
        </section>
      ) : null}
    </div>
  );
}
