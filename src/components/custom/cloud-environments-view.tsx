// @polsia:user-owned — Cloud Environments view: provider badges + connection
// label + last-scan timestamp, one row per persisted connection across
// AWS / Azure / GCP. Pure presentation island — fetch goes through
// /api/cloud/environments over apiFetch so the data-plane rule (no
// @/lib/db in client components) holds.

'use client';

import { Cloud, ExternalLink, Loader2, Plus, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/api-client';
import { brand } from '@/lib/brand';
import {
  type CloudDiscoverProvider,
  type CloudEnvironmentItem,
  CloudEnvironmentsList,
} from '@/lib/contracts/cloud-discover';

function providerLabel(provider: CloudDiscoverProvider): string {
  switch (provider) {
    case 'aws':
      return 'AWS';
    case 'azure':
      return 'Azure';
    case 'gcp':
      return 'GCP';
  }
}

function providerBadgeClass(provider: CloudDiscoverProvider): string {
  // Provider-tinted colors — pulled from the on-palette scale so the
  // badges stay on-brand. AWS is the warm brand tint, Azure the cool
  // tint, GCP the green-Y accent.
  switch (provider) {
    case 'aws':
      return 'bg-brand-500/15 text-brand-700 border-brand-500/30';
    case 'azure':
      return 'bg-info/15 text-info border-info/30';
    case 'gcp':
      return 'bg-success/15 text-success border-success/30';
  }
}

function statusVariant(
  status: CloudEnvironmentItem['status'],
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === null) return 'outline';
  switch (status) {
    case 'succeeded':
      return 'secondary';
    case 'running':
      return 'default';
    case 'queued':
      return 'outline';
    case 'failed':
      return 'destructive';
  }
}

function formatLastScan(value: string | null): string {
  if (!value) return 'never';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

export function CloudEnvironmentsView() {
  const [items, setItems] = useState<CloudEnvironmentItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const next = await apiFetch('/api/cloud/environments', { schema: CloudEnvironmentsList });
        if (!active) return;
        setItems(next.items);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Failed to load environments');
        setItems([]);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

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
  if (items === null) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-caption text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading environments…
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <Card className="overflow-hidden border-border/80 bg-card shadow-md">
        <CardHeader className="border-b border-border bg-muted/30">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-eyebrow text-muted-foreground">
                <ShieldCheck className="mr-1 inline size-3.5 align-[-0.18em]" /> Cloud inventory
              </p>
              <CardTitle className="mt-2 font-display text-h2 text-foreground">
                Connected environments
              </CardTitle>
              <CardDescription className="mt-1">
                {`Each connection is a discrete AWS / Azure / GCP account or project that ${brand.name}
                inventories. The badge color encodes the provider; the timestamp reflects the most
                recent successful discovery scan.`}
              </CardDescription>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link href="/cloud/connections">
                <Plus className="mr-1 size-4" aria-hidden /> Manage connections
              </Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {items.length === 0 ? (
            <div className="flex items-center gap-3 px-6 py-10 text-caption text-muted-foreground">
              <Cloud className="size-5 text-brand-500" aria-hidden />
              <div>
                <p className="text-body text-foreground">No cloud accounts connected yet.</p>
                <p className="mt-1">
                  Add an AWS cross-account role, an Azure service principal, or a GCP service
                  account on the{' '}
                  <Link href="/cloud/connections" className="underline-offset-2 hover:underline">
                    connections page
                  </Link>{' '}
                  to start scanning.
                </p>
              </div>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((item) => (
                <li
                  key={`${item.provider}:${item.connectionId}`}
                  className="grid grid-cols-1 gap-3 px-6 py-4 sm:grid-cols-[12rem_1fr_auto] sm:items-center"
                >
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={`font-mono text-caption uppercase tracking-wider ${providerBadgeClass(item.provider)}`}
                    >
                      {providerLabel(item.provider)}
                    </Badge>
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground text-body">
                      {item.connectionLabel}
                    </p>
                    <p className="text-caption text-muted-foreground">
                      Last scan:{' '}
                      <span className="font-mono">{formatLastScan(item.lastScanAt)}</span>
                      {' · '}
                      {item.resourceCount} resource{item.resourceCount === 1 ? '' : 's'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={statusVariant(item.status)}
                      className="font-mono text-caption uppercase tracking-wider"
                    >
                      {item.status ?? 'no scans'}
                    </Badge>
                    {item.runId ? (
                      <Button asChild variant="ghost" size="sm">
                        <Link href={`/cloud/runs/${item.runId}`}>
                          <ExternalLink className="size-4" aria-hidden /> View
                        </Link>
                      </Button>
                    ) : (
                      <Button asChild variant="ghost" size="sm">
                        <Link href="/cloud/connections">Connect</Link>
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
