// @polsia:user-owned — Client island for dated, per-scan asset risk history.
'use client';

import { Activity, ArrowDownRight, ArrowUpRight, Download, Minus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CsvExporter } from '@/components/custom/csv-exporter';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-client';
import {
  calculateRiskScoreChange,
  type RiskScoreChange,
} from '@/lib/business/assets-risk-trend-summary';
import {
  AssetRiskTrend,
  type AssetRiskTrend as AssetRiskTrendData,
  type AssetRiskTrendPoint,
} from '@/lib/contracts/assets-risk-trend';

interface AssetRiskTrendSparklineProps {
  host: string;
}

interface KeyedPoint {
  key: string;
  point: AssetRiskTrendPoint;
}

function withStablePointKeys(series: AssetRiskTrendData['series']): KeyedPoint[] {
  const occurrences = new Map<string, number>();
  return series.map((point) => {
    const identity = `${point.scannedAt}:${point.score}`;
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { key: `${identity}:${occurrence}`, point };
  });
}

function formatScanDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}

function buildPath(series: AssetRiskTrendData['series']): string {
  if (series.length === 0) return '';
  const values = series.map((point) => point.score);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const width = 360;
  const top = 6;
  const height = 50;
  const slotWidth = width / Math.max(1, series.length - 1);

  return series
    .map((point, index) => {
      const x = index * slotWidth;
      const y = top + height - ((point.score - min) / range) * height;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

export function AssetRiskTrendSparkline({ host }: AssetRiskTrendSparklineProps) {
  const [data, setData] = useState<AssetRiskTrendData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setData(null);
    setError(null);
    apiFetch(`/api/assets/${encodeURIComponent(host)}/risk-trend`, { schema: AssetRiskTrend })
      .then((payload) => {
        if (active) setData(payload);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Unknown error');
      });
    return () => {
      active = false;
    };
  }, [host]);

  if (error) {
    return (
      <Card className="border-border/80 bg-card shadow-sm" data-testid="asset-risk-trend-error">
        <CardHeader className="space-y-2">
          <CardDescription className="text-eyebrow uppercase tracking-wider text-muted-foreground">
            Risk-score history
          </CardDescription>
          <CardTitle className="flex items-center gap-2 text-h3 tracking-tight text-foreground">
            <Activity className="size-5 text-brand-500" aria-hidden />
            Risk-score trend
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p role="alert" className="max-w-prose text-body text-muted-foreground">
            Couldn’t load risk-score history for this host. Scan coverage and the alerts list above
            are unaffected.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!data) return <AssetRiskTrendSparklineSkeleton />;
  if (data.series.length === 0) return <AssetRiskTrendSparklineEmpty host={host} />;

  const newestFirstSeries = [...data.series].reverse();
  const recentSeries = newestFirstSeries.slice(0, 5);

  return (
    <Card className="border-border/80 bg-card shadow-sm" data-testid="asset-risk-trend">
      <CardHeader className="space-y-2">
        <CardDescription className="text-eyebrow uppercase tracking-wider text-muted-foreground">
          Risk-score history
        </CardDescription>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <CardTitle className="flex items-center gap-2 font-display text-h3 tracking-tight text-foreground">
            <Activity className="size-5 text-brand-500" aria-hidden />
            Risk-score trend
          </CardTitle>
          <CsvExporter
            sourceId="vulnaware-asset-risk-history"
            endpoint="/api/assets/export.csv"
            filters={{ host }}
            buttonVariant="outline"
            buttonSize="sm"
            buttonClassName="w-full sm:w-auto"
            label={
              <>
                <Download aria-hidden="true" className="mr-1.5 size-3.5" />
                Download CSV
              </>
            }
          />
        </div>
        <CardDescription className="text-caption text-muted-foreground">
          Persisted scan scores for <span className="font-mono">{host}</span> over the last 30 days.
          The chart runs oldest to newest; the five most recent scans are listed newest first.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(12rem,0.65fr)] md:items-start">
        <div className="flex min-w-0 flex-col gap-3">
          <TrendSparkline series={data.series} />
          <ol
            aria-label="Five most recent risk scores by scan date, newest first"
            className="grid max-h-48 grid-cols-1 gap-x-4 gap-y-1 overflow-y-auto text-caption sm:grid-cols-2"
            data-testid="asset-risk-trend-points"
          >
            {withStablePointKeys(recentSeries).map(({ key, point }) => (
              <li
                className="flex items-center justify-between gap-3 rounded-sm px-1 py-1"
                data-testid="asset-risk-trend-point"
                key={key}
              >
                <time className="text-muted-foreground" dateTime={point.scannedAt}>
                  {formatScanDate(point.scannedAt)}
                </time>
                <span className="font-mono tabular-nums">Score {point.score}</span>
              </li>
            ))}
          </ol>
        </div>
        <RiskScoreChangeSummary change={calculateRiskScoreChange(data.series)} />
      </CardContent>
    </Card>
  );
}

function TrendSparkline({ series }: { series: AssetRiskTrendData['series'] }) {
  const path = buildPath(series);
  const first = series[0];
  const last = series.at(-1);

  return (
    <div className="flex flex-col gap-2" data-testid="asset-risk-trend-spark">
      <div className="flex items-baseline justify-between gap-2 text-caption text-muted-foreground">
        <span>Scan score</span>
        <span className="font-mono tabular-nums">
          Latest: <span className="text-foreground">{last?.score}</span>
        </span>
      </div>
      <svg
        aria-label={`Risk scores across ${series.length} scans from ${first?.scannedAt} to ${last?.scannedAt}`}
        className="h-16 w-full"
        role="img"
        viewBox="0 0 360 64"
      >
        <title>Persisted risk score for each scan, ordered by scan time</title>
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          className="text-brand-500"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div className="flex justify-between gap-2 font-mono text-[10px] text-muted-foreground">
        <time dateTime={first?.scannedAt}>{first ? formatScanDate(first.scannedAt) : ''}</time>
        <time dateTime={last?.scannedAt}>{last ? formatScanDate(last.scannedAt) : ''}</time>
      </div>
    </div>
  );
}

function AssetRiskTrendSparklineEmpty({ host }: { host: string }) {
  return (
    <Card className="border-border/80 bg-card shadow-sm" data-testid="asset-risk-trend-empty">
      <CardHeader className="space-y-2">
        <CardDescription className="text-eyebrow uppercase tracking-wider text-muted-foreground">
          Risk-score history
        </CardDescription>
        <CardTitle className="flex items-center gap-2 font-display text-h3 tracking-tight text-foreground">
          <Activity className="size-5 text-brand-500" aria-hidden />
          Risk-score trend
        </CardTitle>
        <CardDescription className="text-caption text-muted-foreground">
          Last 30 days on <span className="font-mono">{host}</span>.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(12rem,0.65fr)] md:items-start">
        <p className="max-w-prose text-body text-muted-foreground">
          No dated risk scores are available for this host in the last 30 days.
        </p>
        <RiskScoreChangeSummary change={null} />
      </CardContent>
    </Card>
  );
}

function RiskScoreChangeSummary({ change }: { change: RiskScoreChange | null }) {
  const direction = change
    ? change.delta > 0
      ? 'Risk increased'
      : change.delta < 0
        ? 'Risk decreased'
        : 'No change'
    : null;
  const DirectionIcon = change
    ? change.delta > 0
      ? ArrowUpRight
      : change.delta < 0
        ? ArrowDownRight
        : Minus
    : null;

  return (
    <section
      aria-label="30-day score change"
      className="min-w-0 rounded-lg border border-border/70 bg-muted/20 p-4"
      data-testid="asset-risk-trend-summary"
    >
      <p className="text-eyebrow uppercase tracking-wider text-muted-foreground">
        30-day score change
      </p>
      {change && direction && DirectionIcon ? (
        <div className="mt-3 space-y-2">
          <p className="flex items-center gap-2 text-body font-medium text-foreground">
            <DirectionIcon className="size-4 text-muted-foreground" aria-hidden />
            <span>{direction}</span>
          </p>
          <dl className="space-y-2 text-caption">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Baseline scan date</dt>
              <dd className="text-right text-foreground">
                <time
                  data-testid="asset-risk-baseline-date"
                  dateTime={change.earliestScannedAt}
                  title={change.earliestScannedAt}
                >
                  {formatScanDate(change.earliestScannedAt)}
                </time>
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Baseline risk score</dt>
              <dd className="font-mono tabular-nums text-foreground">
                {change.earliestScore.toFixed(2)}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Latest scan date</dt>
              <dd className="text-right text-foreground">
                <time
                  data-testid="asset-risk-latest-date"
                  dateTime={change.latestScannedAt}
                  title={change.latestScannedAt}
                >
                  {formatScanDate(change.latestScannedAt)}
                </time>
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Latest risk score</dt>
              <dd className="font-mono tabular-nums text-foreground">
                {change.latestScore.toFixed(2)}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Change</dt>
              <dd className="font-mono text-h3 tabular-nums text-foreground">
                {formatRiskScoreChange(change.delta)}
              </dd>
            </div>
          </dl>
        </div>
      ) : (
        <output className="mt-3" data-testid="asset-risk-trend-summary-unavailable">
          <p className="text-body font-medium text-foreground">
            Unavailable — need at least two valid dated scores
          </p>
        </output>
      )}
    </section>
  );
}

function formatRiskScoreChange(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(2)} points`;
}

function AssetRiskTrendSparklineSkeleton() {
  return (
    <Card
      aria-label="Loading risk-score history"
      className="border-border/80 bg-card shadow-sm"
      data-testid="asset-risk-trend-loading"
    >
      <CardHeader className="space-y-2">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-64" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-8 w-full" />
      </CardContent>
    </Card>
  );
}
