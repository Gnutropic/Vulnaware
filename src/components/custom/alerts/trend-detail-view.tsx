// @polsia:user-owned — Client island for /alerts/trend/[cveId]. Fetches
// one AlertTrendDetail envelope from /api/alerts/trend/[cveId] via
// apiFetch and renders Loading / Error / Empty / Success states per
// the data-plane skill. NEVER touches a Response attribute — apiFetch
// returns the parsed body and throws on non-2xx.
//
// 404 from the API surfaces as "this CVE is not currently trending"
// (Loading→Empty). Any other failure surfaces as an explicit error
// card so operators see a real message instead of a silent spinner.

'use client';

import { ArrowLeft, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-client';
import { AlertTrendDetail as AlertTrendDetailSchema } from '@/lib/contracts/alerts';

type AlertTrendDetail = z.infer<typeof AlertTrendDetailSchema>;

export interface TrendDetailViewProps {
  cveId: string;
}

type FetchState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | { kind: 'success'; data: AlertTrendDetail };

export function TrendDetailView({ cveId }: TrendDetailViewProps) {
  const [state, setState] = useState<FetchState>({ kind: 'loading' });

  useEffect(() => {
    let active = true;
    apiFetch(`/api/alerts/trend/${encodeURIComponent(cveId)}`, {
      schema: AlertTrendDetailSchema,
    })
      .then((data) => {
        if (!active) return;
        setState({ kind: 'success', data });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const status =
          err instanceof Error && typeof err.cause === 'object' && err.cause !== null
            ? (err.cause as { status?: number }).status
            : undefined;
        if (status === 404) {
          setState({ kind: 'empty' });
          return;
        }
        const msg = err instanceof Error ? err.message : 'Unknown error';
        setState({ kind: 'error', message: msg });
      });
    return () => {
      active = false;
    };
  }, [cveId]);

  if (state.kind === 'loading') {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load trending detail</AlertTitle>
        <AlertDescription className="font-mono text-caption">{state.message}</AlertDescription>
      </Alert>
    );
  }

  if (state.kind === 'empty') {
    return (
      <div className="flex flex-col gap-4">
        <header className="flex flex-col gap-2">
          <p className="text-caption text-muted-foreground">
            <TrendingUp className="mr-1.5 inline size-4 align-[-0.18em] text-muted-foreground" />
            Trend detail
          </p>
          <h1 className="font-display text-h2 tracking-tight text-foreground">
            <span className="font-mono text-body-lg">{cveId}</span> is not currently trending.
          </h1>
          <p className="max-w-prose text-body text-muted-foreground">
            The daily VelocityTrend cron has not flagged this CVE as accelerating in the last 30
            days. Either the workspace has seen fewer alerts for it than in the prior window, or the
            workspace's trend row is empty.
          </p>
        </header>
        <Button asChild variant="outline" size="sm" className="self-start">
          <Link href="/alerts">
            <ArrowLeft aria-hidden="true" className="size-3.5" />
            Back to alerts
          </Link>
        </Button>
      </div>
    );
  }

  const data = state.data;
  const delta = data.recentCount - data.priorCount;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium text-muted-foreground">
          <TrendingUp className="mr-1.5 inline size-4 align-[-0.18em] text-brand-500" />
          Trending
        </p>
        <h1 className="font-display text-h1 tracking-tight text-foreground">
          <span className="font-mono text-body-lg">{data.cveId}</span>
        </h1>
        <p className="max-w-prose text-body-lg text-muted-foreground">
          This CVE is in the workspace&apos;s current accelerating set. The daily VelocityTrend cron
          compared the last 30 days against the prior 30 days and flagged it.
        </p>
      </header>

      <section
        aria-label="Velocity summary"
        className="grid gap-4 rounded-lg border border-border bg-card p-4 sm:grid-cols-3"
      >
        <Stat label="Velocity" value={`${data.velocity > 0 ? '+' : ''}${data.velocity}`} />
        <Stat label="Last 30d" value={String(data.recentCount)} />
        <Stat label="Prior 30d" value={String(data.priorCount)} />
      </section>

      <section aria-label="Per-CVE delta" className="rounded-lg border border-border bg-card p-4">
        <p className="text-caption text-muted-foreground">Per-CVE delta</p>
        <p className="font-display text-h3 tracking-tight text-foreground">
          {delta > 0 ? `+${delta}` : delta} alerts
        </p>
        <p className="text-body text-muted-foreground">
          Difference between the last 30 days and the prior 30 days for this CVE, scoped to your
          workspace. Window: {new Date(data.windowStart).toLocaleDateString()} →{' '}
          {new Date(data.windowEnd).toLocaleDateString()}. Computed{' '}
          {new Date(data.computedAt).toLocaleString()}.
        </p>
      </section>

      {data.acceleratingIncreases.length > 1 ? (
        <section aria-label="Other accelerating CVEs" className="flex flex-col gap-3">
          <h2 className="font-display text-h3 tracking-tight text-foreground">
            Other accelerating CVEs
          </h2>
          <ul className="flex flex-wrap gap-2">
            {data.acceleratingIncreases
              .filter((c) => c !== data.cveId)
              .map((c) => (
                <li key={c}>
                  <Badge asChild variant="outline" className="font-mono text-caption">
                    <Link href={`/alerts/trend/${encodeURIComponent(c)}`}>{c}</Link>
                  </Badge>
                </li>
              ))}
          </ul>
        </section>
      ) : null}

      <div>
        <Button asChild variant="outline" size="sm">
          <Link href="/alerts">
            <ArrowLeft aria-hidden="true" className="size-3.5" />
            Back to alerts
          </Link>
        </Button>
      </div>
    </div>
  );
}

interface StatProps {
  label: string;
  value: string;
}

function Stat({ label, value }: StatProps) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-caption text-muted-foreground">{label}</p>
      <p className="font-display text-h2 tracking-tight text-foreground">{value}</p>
    </div>
  );
}
