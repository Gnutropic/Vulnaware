// @polsia:user-owned — Header card for a single scan target. Pure presentational
// composition of Card + Badge; no data fetching here.

'use client';

import { Globe2, Loader2, ScanSearch } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { ScanItem } from '@/lib/contracts/scan';
import { cn } from '@/lib/utils';

function statusVariant(
  status: ScanItem['status'],
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'completed':
      return 'default';
    case 'failed':
      return 'destructive';
    case 'running':
      return 'secondary';
    case 'queued':
      return 'outline';
  }
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

export function ScanResultCard({ scan }: { scan: ScanItem }) {
  const openCount = scan.assets.filter((a) => a.state === 'up').length;
  return (
    <Card className="overflow-hidden border-border/80 bg-card shadow-sm">
      <CardHeader className="border-b border-border bg-muted/30">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-eyebrow text-muted-foreground">
              <ScanSearch className="mr-1 inline size-3.5 align-[-0.18em]" /> Scan target
            </p>
            <CardTitle className="mt-2 flex items-center gap-2 truncate font-display text-h2 text-foreground">
              <Globe2 className="size-5 shrink-0 text-brand-500" aria-hidden />
              <span className="truncate">{scan.target}</span>
            </CardTitle>
            <CardDescription className="mt-1 font-mono text-caption text-muted-foreground">
              Mode: {scan.mode} · Started: {formatDate(scan.startedAt)}
              {scan.finishedAt ? <> · Finished: {formatDate(scan.finishedAt)}</> : null}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              variant={statusVariant(scan.status)}
              className="font-mono text-caption uppercase tracking-wider"
            >
              {scan.status === 'running' ? (
                <Loader2 className="mr-1 size-3 animate-spin" aria-hidden />
              ) : null}
              {scan.status}
            </Badge>
            <Badge variant="outline" className="font-mono">
              {openCount} / {scan.assets.length} open
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 p-6 sm:grid-cols-3">
        <Stat label="Hosts reached" value={scan.assets.length} />
        <Stat label="Open ports" value={openCount} accent="text-brand-500" />
        <Stat
          label="Findings"
          value={scan.findings.length}
          accent={scan.findings.length > 0 ? 'text-destructive' : undefined}
        />
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-border bg-background px-4 py-3">
      <p className="text-caption uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn('mt-1 font-display text-h2 leading-none text-foreground', accent)}>
        {value}
      </p>
    </div>
  );
}
