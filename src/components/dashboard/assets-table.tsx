// @polsia:user-owned — Per-host row table for the /assets page. Pure
// presentational: receives the parsed `AssetList`, renders one row per
// scanned host. Each row's `Host` cell and the right-aligned "View
// host" link both drill into the per-host detail page at
// `/assets/<encoded host>`, where the operator sees exactly that
// host's alerts with the same filter / sort affordances as /alerts.
//
// Mobile (< md): stacked cards. Desktop (md+): sortable table.
//
// No apiFetch here — the parent page owns the fetch lifecycle.

'use client';

import { Server } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatAssetScanAge, NO_SCAN_HISTORY_LABEL } from '@/lib/business/assets-scan-recency';
import type {
  AssetAlertPresence,
  AssetRiskTrend,
  AssetRollupRow,
  AssetScanRecency,
  AssetScanStatus,
  AssetSeverity,
  AssetSortKey,
} from '@/lib/contracts/assets';

const SKELETON_ROW_KEYS = ['sk-0', 'sk-1', 'sk-2', 'sk-3', 'sk-4', 'sk-5', 'sk-6', 'sk-7'];

// `—` placeholder for the `Last activity` cell when the helper's peer-
// read returned no resolvable stamp. Same em-dash the /alerts page
// uses so cross-page chrome stays uniform.
const NULL_TIMESTAMP_PLACEHOLDER = '—';

function formatLastActivity(value: string | null): string {
  if (value == null) return NULL_TIMESTAMP_PLACEHOLDER;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return NULL_TIMESTAMP_PLACEHOLDER;
  return d.toLocaleString();
}

function LatestScanValue({ value, now }: { value: string | null; now: Date }) {
  const relativeAge = formatAssetScanAge(value, now);
  if (value == null || relativeAge === NO_SCAN_HISTORY_LABEL) {
    return <span>{relativeAge}</span>;
  }

  const absoluteTimestamp = new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <time dateTime={value} title={relativeAge}>
        {absoluteTimestamp}
      </time>
      <span className="text-muted-foreground/80">({relativeAge})</span>
    </span>
  );
}

function scanStatusVariant(
  status: AssetScanStatus,
): 'default' | 'destructive' | 'secondary' | 'outline' {
  if (status === 'completed') return 'default';
  if (status === 'failed') return 'destructive';
  if (status === 'running') return 'secondary';
  return 'outline';
}

function scanStatusLabel(status: AssetScanStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function LatestScanStatus({ status }: { status: AssetRollupRow['latestScanStatus'] }) {
  if (status === null) return null;

  return (
    <Badge variant={scanStatusVariant(status)} className="font-mono text-caption">
      {scanStatusLabel(status)}
    </Badge>
  );
}

function unresolvedSeverityVariant(
  severity: AssetSeverity,
): 'destructive' | 'secondary' | 'outline' {
  if (severity === 'critical' || severity === 'high') return 'destructive';
  if (severity === 'medium') return 'secondary';
  return 'outline';
}

function UnresolvedSeverity({ severity }: { severity: AssetSeverity | null }) {
  if (severity === null) return null;

  return (
    <Badge
      variant={unresolvedSeverityVariant(severity)}
      className="font-mono text-caption uppercase tracking-wider"
      aria-label={`Highest unresolved severity: ${severity}`}
      data-testid="asset-unresolved-severity"
    >
      Severity {severity}
    </Badge>
  );
}

function formatRiskScore(value: number | null): string {
  return value == null ? '—' : `${value.toFixed(2)} /10`;
}

function formatRiskScoreChange(value: number | null): string {
  if (value == null) return 'Unavailable — need at least two dated scores';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(2)} points`;
}

function riskScoreChangeDirection(value: number): string {
  return value > 0 ? 'Increased' : value < 0 ? 'Decreased' : 'No change';
}

function RiskScoreChangeValue({ value }: { value: number | null }) {
  if (value == null) {
    return <span data-testid="asset-risk-score-change">{formatRiskScoreChange(value)}</span>;
  }

  return (
    <span data-testid="asset-risk-score-change">
      {riskScoreChangeDirection(value)}: {formatRiskScoreChange(value)}
    </span>
  );
}

function drilldownHref(host: string): string {
  return `/assets/${encodeURIComponent(host)}`;
}

function riskSortAriaLabel(sort: AssetSortKey): string {
  if (sort === 'riskScore') {
    return 'Sort by risk score. Current order: descending. Activate to sort ascending.';
  }
  if (sort === 'riskScore:asc') {
    return 'Sort by risk score. Current order: ascending. Activate to sort descending.';
  }
  return 'Sort by risk score descending';
}

function unresolvedSortAriaLabel(sort: AssetSortKey): string {
  if (sort === 'unresolvedCount') {
    return 'Sort by unresolved alerts. Current order: descending. Activate to sort ascending.';
  }
  if (sort === 'unresolvedCount:asc') {
    return 'Sort by unresolved alerts. Current order: ascending. Activate to sort descending.';
  }
  return 'Sort by unresolved alerts. Activate to sort descending.';
}

function riskScoreChangeSortAriaLabel(sort: AssetSortKey): string {
  if (sort === 'riskScoreChange') {
    return 'Sort by 30-day change. Current order: descending. Activate to sort ascending.';
  }
  if (sort === 'riskScoreChange:asc') {
    return 'Sort by 30-day change. Current order: ascending. Activate to sort descending.';
  }
  return 'Sort by 30-day change. Activate to sort descending.';
}

function latestScanSortAriaLabel(sort: AssetSortKey): string {
  if (sort === 'latestScanAt') {
    return 'Sort by latest scan date. Current order: newest first. Activate to sort oldest first.';
  }
  if (sort === 'latestScanAt:asc') {
    return 'Sort by latest scan date. Current order: oldest first. Activate to sort newest first.';
  }
  return 'Sort by latest scan date, newest first.';
}

export interface AssetsTableProps {
  items: AssetRollupRow[];
  sort: AssetSortKey;
  onSortChange: (next: AssetSortKey) => void;
  query?: string;
  clearQueryHref?: string;
  minRiskScore?: number | null;
  clearMinRiskScoreHref?: string;
  scanRecency?: AssetScanRecency;
  clearScanRecencyHref?: string;
  latestScanStatus?: AssetScanStatus | null;
  clearLatestScanStatusHref?: string;
  neverScanned?: boolean;
  clearNeverScannedHref?: string;
  riskTrend?: AssetRiskTrend | null;
  clearRiskTrendHref?: string;
  alertPresence?: AssetAlertPresence;
  clearAlertPresenceHref?: string;
}

interface EmptyAssetsStateProps {
  query: string;
  clearQueryHref: string;
  minRiskScore: number | null;
  clearMinRiskScoreHref: string;
  scanRecency: AssetScanRecency;
  clearScanRecencyHref: string;
  latestScanStatus: AssetScanStatus | null;
  clearLatestScanStatusHref: string;
  neverScanned: boolean;
  clearNeverScannedHref: string;
  riskTrend: AssetRiskTrend | null;
  clearRiskTrendHref: string;
  alertPresence: AssetAlertPresence;
  clearAlertPresenceHref: string;
}

function EmptyAssetsState({
  query,
  clearQueryHref,
  minRiskScore,
  clearMinRiskScoreHref,
  scanRecency,
  clearScanRecencyHref,
  latestScanStatus,
  clearLatestScanStatusHref,
  neverScanned,
  clearNeverScannedHref,
  riskTrend,
  clearRiskTrendHref,
  alertPresence,
  clearAlertPresenceHref,
}: EmptyAssetsStateProps) {
  const hasQuery = query.length > 0;
  const hasRiskThreshold = minRiskScore !== null;
  const hasScanRecency = scanRecency !== 'all';
  const hasLatestScanStatus = latestScanStatus !== null;
  const hasNeverScanned = neverScanned;
  const hasRiskTrend = riskTrend !== null;
  const hasAlertPresence = alertPresence !== 'all';
  const scanRecencyLabel = {
    last24h: 'Scanned in the last 24 hours',
    last7d: 'Scanned in the last 7 days',
    last30d: 'Scanned in the past 30 days',
    noRecent30d: 'No scans in the past 30 days',
    older: 'Stale (more than 30 days)',
    never: 'No scan history',
    all: 'All scan history',
  }[scanRecency];
  const riskTrendLabel = {
    rising: 'Rising',
    falling: 'Falling',
    unchanged: 'Unchanged',
  }[riskTrend ?? 'rising'];
  const alertPresenceLabel =
    alertPresence === 'with' ? 'with unresolved alerts' : 'without unresolved alerts';

  const filterDescription = [
    hasQuery ? `matching “${query}”` : null,
    hasRiskThreshold ? `with a minimum risk score of ${minRiskScore}` : null,
    hasScanRecency ? `with scan recency “${scanRecencyLabel}”` : null,
    hasLatestScanStatus ? `with latest scan status “${latestScanStatus}”` : null,
    hasNeverScanned ? 'with no completed scan history' : null,
    hasRiskTrend ? `with a 30-day risk trend of “${riskTrendLabel}”` : null,
    hasAlertPresence ? alertPresenceLabel : null,
  ].filter((part): part is string => part !== null);

  return (
    <div className="flex flex-col items-center gap-3">
      <p>
        {!hasScanRecency && !hasLatestScanStatus && hasRiskThreshold
          ? hasQuery
            ? `No assets matching “${query}” with a minimum risk score of ${minRiskScore} were found in the active workspace.`
            : `No assets with a risk score of at least ${minRiskScore} were found in the active workspace.`
          : !hasScanRecency && !hasLatestScanStatus && hasQuery
            ? `No assets matching “${query}” were found in the active workspace.`
            : filterDescription.length > 0
              ? `No assets ${filterDescription.join(' ')} were found in the active workspace.`
              : 'No assets have been discovered in the active workspace yet.'}
      </p>
      {hasAlertPresence ? (
        <Button asChild variant="outline" size="sm">
          <Link href={clearAlertPresenceHref}>Clear unresolved-alert filter</Link>
        </Button>
      ) : hasRiskTrend ? (
        <Button asChild variant="outline" size="sm">
          <Link href={clearRiskTrendHref}>Clear risk trend filter</Link>
        </Button>
      ) : hasScanRecency ? (
        <Button asChild variant="outline" size="sm">
          <Link href={clearScanRecencyHref}>Clear scan recency filter</Link>
        </Button>
      ) : hasLatestScanStatus ? (
        <Button asChild variant="outline" size="sm">
          <Link href={clearLatestScanStatusHref}>Clear latest scan status filter</Link>
        </Button>
      ) : hasNeverScanned ? (
        <Button asChild variant="outline" size="sm">
          <Link href={clearNeverScannedHref}>Clear Never scanned filter</Link>
        </Button>
      ) : hasRiskThreshold ? (
        <Button asChild variant="outline" size="sm">
          <Link href={clearMinRiskScoreHref}>Clear minimum risk score</Link>
        </Button>
      ) : hasQuery ? (
        <Button asChild variant="outline" size="sm">
          <Link href={clearQueryHref}>Clear hostname search</Link>
        </Button>
      ) : null}
    </div>
  );
}

export function AssetsTable({
  items,
  sort,
  onSortChange,
  query = '',
  clearQueryHref = '/assets',
  minRiskScore = null,
  clearMinRiskScoreHref = '/assets',
  scanRecency = 'all',
  clearScanRecencyHref = '/assets',
  latestScanStatus = null,
  clearLatestScanStatusHref = '/assets',
  neverScanned = false,
  clearNeverScannedHref = '/assets',
  riskTrend = null,
  clearRiskTrendHref = '/assets',
  alertPresence = 'all',
  clearAlertPresenceHref = '/assets',
}: AssetsTableProps) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const riskSort = sort === 'riskScore' || sort === 'riskScore:asc' ? sort : null;
  const toggleRiskSort = () =>
    onSortChange(riskSort === 'riskScore' ? 'riskScore:asc' : 'riskScore');
  const unresolvedSort = sort === 'unresolvedCount' || sort === 'unresolvedCount:asc' ? sort : null;
  const toggleUnresolvedSort = () =>
    onSortChange(unresolvedSort === 'unresolvedCount' ? 'unresolvedCount:asc' : 'unresolvedCount');
  const riskScoreChangeSort =
    sort === 'riskScoreChange' || sort === 'riskScoreChange:asc' ? sort : null;
  const toggleRiskScoreChangeSort = () =>
    onSortChange(
      riskScoreChangeSort === 'riskScoreChange' ? 'riskScoreChange:asc' : 'riskScoreChange',
    );
  const latestScanSort = sort === 'latestScanAt' || sort === 'latestScanAt:asc' ? sort : null;
  const toggleLatestScanSort = () =>
    onSortChange(latestScanSort === 'latestScanAt' ? 'latestScanAt:asc' : 'latestScanAt');

  return (
    <div className="flex flex-col gap-2">
      <p className="text-caption text-muted-foreground">
        {items.length} {items.length === 1 ? 'host' : 'hosts'}
      </p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 md:hidden">
        <span className="text-caption text-muted-foreground">Sort by:</span>
        <button
          type="button"
          onClick={toggleRiskSort}
          aria-pressed={riskSort !== null}
          aria-label={riskSortAriaLabel(sort)}
          className="inline-flex items-center gap-1.5 rounded font-medium text-foreground transition-colors hover:text-brand-600"
        >
          Risk score
          {riskSort === 'riskScore' ? (
            <span aria-hidden className="font-mono text-caption text-brand-600">
              ↓
            </span>
          ) : riskSort === 'riskScore:asc' ? (
            <span aria-hidden className="font-mono text-caption text-brand-600">
              ↑
            </span>
          ) : null}
        </button>
        <button
          type="button"
          onClick={toggleUnresolvedSort}
          aria-pressed={unresolvedSort !== null}
          aria-label={unresolvedSortAriaLabel(sort)}
          className="inline-flex items-center gap-1.5 rounded font-medium text-foreground transition-colors hover:text-brand-600"
        >
          Unresolved alerts
          {unresolvedSort === 'unresolvedCount' ? (
            <span aria-hidden className="font-mono text-caption text-brand-600">
              ↓
            </span>
          ) : unresolvedSort === 'unresolvedCount:asc' ? (
            <span aria-hidden className="font-mono text-caption text-brand-600">
              ↑
            </span>
          ) : null}
        </button>
        <button
          type="button"
          onClick={toggleRiskScoreChangeSort}
          aria-pressed={riskScoreChangeSort !== null}
          aria-label={riskScoreChangeSortAriaLabel(sort)}
          className="inline-flex items-center gap-1.5 rounded font-medium text-foreground transition-colors hover:text-brand-600"
        >
          30-day change
          {riskScoreChangeSort === 'riskScoreChange' ? (
            <span aria-hidden className="font-mono text-caption text-brand-600">
              ↓
            </span>
          ) : riskScoreChangeSort === 'riskScoreChange:asc' ? (
            <span aria-hidden className="font-mono text-caption text-brand-600">
              ↑
            </span>
          ) : null}
        </button>
        <button
          type="button"
          onClick={toggleLatestScanSort}
          aria-pressed={latestScanSort !== null}
          aria-label={latestScanSortAriaLabel(sort)}
          className="inline-flex items-center gap-1.5 rounded font-medium text-foreground transition-colors hover:text-brand-600"
        >
          Latest scan
          {latestScanSort === 'latestScanAt' ? (
            <span aria-hidden className="font-mono text-caption text-brand-600">
              ↓
            </span>
          ) : latestScanSort === 'latestScanAt:asc' ? (
            <span aria-hidden className="font-mono text-caption text-brand-600">
              ↑
            </span>
          ) : null}
        </button>
      </div>

      {/* Mobile (< md): stacked cards, no horizontal scroll. */}
      <ul className="flex flex-col gap-3 md:hidden">
        {items.length === 0 ? (
          <li className="rounded-lg border border-border bg-card p-6 text-center text-body text-muted-foreground">
            <EmptyAssetsState
              query={query}
              clearQueryHref={clearQueryHref}
              minRiskScore={minRiskScore}
              clearMinRiskScoreHref={clearMinRiskScoreHref}
              scanRecency={scanRecency}
              clearScanRecencyHref={clearScanRecencyHref}
              latestScanStatus={latestScanStatus}
              clearLatestScanStatusHref={clearLatestScanStatusHref}
              neverScanned={neverScanned}
              clearNeverScannedHref={clearNeverScannedHref}
              riskTrend={riskTrend}
              clearRiskTrendHref={clearRiskTrendHref}
              alertPresence={alertPresence}
              clearAlertPresenceHref={clearAlertPresenceHref}
            />
          </li>
        ) : (
          items.map((item) => (
            <li
              key={item.name}
              className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 shadow-sm"
            >
              <div className="flex min-w-0 items-center gap-2">
                <Server aria-hidden="true" className="size-4 shrink-0 text-brand-500" />
                <Link
                  className="block min-w-0 max-w-full flex-1 break-all whitespace-normal rounded-sm font-mono text-body text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  href={drilldownHref(item.name)}
                >
                  {item.name}
                </Link>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge
                  variant="outline"
                  className="font-mono text-caption uppercase tracking-wider"
                >
                  Type {item.assetType}
                </Badge>
                <Badge
                  variant={item.criticalCount > 0 ? 'destructive' : 'outline'}
                  className="font-mono text-caption uppercase tracking-wider"
                >
                  Open alerts {item.openCount}
                </Badge>
                <Badge
                  variant={item.unresolvedCount > 0 ? 'destructive' : 'outline'}
                  className="font-mono text-caption uppercase tracking-wider"
                >
                  Unresolved alerts {item.unresolvedCount}
                </Badge>
                <UnresolvedSeverity severity={item.highestUnresolvedSeverity} />
                <Badge
                  variant={item.criticalCount > 0 ? 'destructive' : 'outline'}
                  className="font-mono text-caption uppercase tracking-wider"
                >
                  Critical {item.criticalCount}
                </Badge>
                <Badge
                  variant="outline"
                  className="font-mono text-caption uppercase tracking-wider"
                >
                  Risk {formatRiskScore(item.riskScore)}
                </Badge>
              </div>
              <div className="grid gap-1 text-caption text-muted-foreground sm:grid-cols-2">
                <span className="min-w-0 break-words">
                  30-day change: <RiskScoreChangeValue value={item.riskScoreChange} />
                </span>
                <span>Last activity: {formatLastActivity(item.lastActivityAt)}</span>
                <span className="min-w-0 break-words">
                  Latest scan:{' '}
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <LatestScanValue value={item.latestScanAt} now={now} />
                    <LatestScanStatus status={item.latestScanStatus} />
                  </span>
                </span>
                <span>30-day scans: {item.scanCount30d}</span>
                <span className="sm:text-right">
                  <Link
                    href={drilldownHref(item.name)}
                    className="text-body underline-offset-2 hover:underline"
                  >
                    View host
                  </Link>
                </span>
              </div>
            </li>
          ))
        )}
      </ul>

      {/* Desktop (md+): table. */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Host</TableHead>
              <TableHead className="w-[7rem]">Asset type</TableHead>
              <TableHead
                className="w-[6rem]"
                aria-sort={
                  sort === 'openCount'
                    ? 'descending'
                    : sort === 'openCount:asc'
                      ? 'ascending'
                      : 'none'
                }
              >
                <button
                  type="button"
                  onClick={() => onSortChange(sort === 'openCount' ? 'openCount:asc' : 'openCount')}
                  className="inline-flex items-center gap-1.5 rounded font-medium text-foreground transition-colors hover:text-brand-600"
                >
                  Open alerts
                  {sort === 'openCount' ? (
                    <span aria-hidden className="font-mono text-caption text-brand-600">
                      ↓
                    </span>
                  ) : sort === 'openCount:asc' ? (
                    <span aria-hidden className="font-mono text-caption text-brand-600">
                      ↑
                    </span>
                  ) : null}
                </button>
              </TableHead>
              <TableHead
                className="w-[9rem]"
                aria-sort={
                  sort === 'unresolvedCount'
                    ? 'descending'
                    : sort === 'unresolvedCount:asc'
                      ? 'ascending'
                      : 'none'
                }
              >
                <button
                  type="button"
                  onClick={toggleUnresolvedSort}
                  aria-label={unresolvedSortAriaLabel(sort)}
                  className="inline-flex items-center gap-1.5 rounded font-medium text-foreground transition-colors hover:text-brand-600"
                >
                  Unresolved alerts
                  {sort === 'unresolvedCount' ? (
                    <span aria-hidden className="font-mono text-caption text-brand-600">
                      ↓
                    </span>
                  ) : sort === 'unresolvedCount:asc' ? (
                    <span aria-hidden className="font-mono text-caption text-brand-600">
                      ↑
                    </span>
                  ) : null}
                </button>
              </TableHead>
              <TableHead className="w-[7rem]">Critical</TableHead>
              <TableHead
                className="w-[8rem]"
                aria-sort={
                  sort === 'riskScore'
                    ? 'descending'
                    : sort === 'riskScore:asc'
                      ? 'ascending'
                      : 'none'
                }
              >
                <button
                  type="button"
                  onClick={toggleRiskSort}
                  aria-label={riskSortAriaLabel(sort)}
                  className="inline-flex items-center gap-1.5 rounded font-medium text-foreground transition-colors hover:text-brand-600"
                >
                  Risk score
                  {sort === 'riskScore' ? (
                    <span aria-hidden className="font-mono text-caption text-brand-600">
                      ↓
                    </span>
                  ) : sort === 'riskScore:asc' ? (
                    <span aria-hidden className="font-mono text-caption text-brand-600">
                      ↑
                    </span>
                  ) : null}
                </button>
              </TableHead>
              <TableHead
                className="w-[14rem]"
                aria-sort={
                  sort === 'riskScoreChange'
                    ? 'descending'
                    : sort === 'riskScoreChange:asc'
                      ? 'ascending'
                      : 'none'
                }
              >
                <button
                  type="button"
                  onClick={toggleRiskScoreChangeSort}
                  aria-label={riskScoreChangeSortAriaLabel(sort)}
                  className="inline-flex items-center gap-1.5 rounded font-medium text-foreground transition-colors hover:text-brand-600"
                >
                  30-day change
                  {sort === 'riskScoreChange' ? (
                    <span aria-hidden className="font-mono text-caption text-brand-600">
                      ↓
                    </span>
                  ) : sort === 'riskScoreChange:asc' ? (
                    <span aria-hidden className="font-mono text-caption text-brand-600">
                      ↑
                    </span>
                  ) : null}
                </button>
              </TableHead>
              <TableHead className="w-[14rem]">Last activity</TableHead>
              <TableHead
                className="w-[14rem]"
                aria-sort={
                  sort === 'latestScanAt'
                    ? 'descending'
                    : sort === 'latestScanAt:asc'
                      ? 'ascending'
                      : 'none'
                }
              >
                <button
                  type="button"
                  onClick={toggleLatestScanSort}
                  aria-label={latestScanSortAriaLabel(sort)}
                  className="inline-flex items-center gap-1.5 rounded font-medium text-foreground transition-colors hover:text-brand-600"
                >
                  Latest scan
                  {latestScanSort === 'latestScanAt' ? (
                    <span aria-hidden className="font-mono text-caption text-brand-600">
                      ↓
                    </span>
                  ) : latestScanSort === 'latestScanAt:asc' ? (
                    <span aria-hidden className="font-mono text-caption text-brand-600">
                      ↑
                    </span>
                  ) : null}
                </button>
              </TableHead>
              <TableHead className="w-[8rem]">30-day scans</TableHead>
              <TableHead className="w-[7rem] text-right">Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={11} className="text-center text-body text-muted-foreground">
                  <EmptyAssetsState
                    query={query}
                    clearQueryHref={clearQueryHref}
                    minRiskScore={minRiskScore}
                    clearMinRiskScoreHref={clearMinRiskScoreHref}
                    scanRecency={scanRecency}
                    clearScanRecencyHref={clearScanRecencyHref}
                    latestScanStatus={latestScanStatus}
                    clearLatestScanStatusHref={clearLatestScanStatusHref}
                    neverScanned={neverScanned}
                    clearNeverScannedHref={clearNeverScannedHref}
                    riskTrend={riskTrend}
                    clearRiskTrendHref={clearRiskTrendHref}
                    alertPresence={alertPresence}
                    clearAlertPresenceHref={clearAlertPresenceHref}
                  />
                </TableCell>
              </TableRow>
            ) : (
              items.map((item) => (
                <TableRow key={item.name}>
                  <TableCell className="font-mono text-caption">
                    <Link
                      href={drilldownHref(item.name)}
                      className="underline-offset-2 hover:underline"
                    >
                      {item.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className="font-mono text-caption uppercase tracking-wider"
                    >
                      {item.assetType}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={item.criticalCount > 0 ? 'destructive' : 'outline'}
                      className="font-mono text-caption"
                    >
                      {item.openCount}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge
                        variant={item.unresolvedCount > 0 ? 'destructive' : 'outline'}
                        className="font-mono text-caption"
                      >
                        Unresolved alerts {item.unresolvedCount}
                      </Badge>
                      <UnresolvedSeverity severity={item.highestUnresolvedSeverity} />
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={item.criticalCount > 0 ? 'destructive' : 'outline'}
                      className="font-mono text-caption"
                    >
                      {item.criticalCount}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-caption tabular-nums">
                    {formatRiskScore(item.riskScore)}
                  </TableCell>
                  <TableCell className="max-w-[14rem] whitespace-normal break-words text-caption text-muted-foreground">
                    <RiskScoreChangeValue value={item.riskScoreChange} />
                  </TableCell>
                  <TableCell className="text-caption text-muted-foreground">
                    {formatLastActivity(item.lastActivityAt)}
                  </TableCell>
                  <TableCell className="text-caption text-muted-foreground">
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <LatestScanValue value={item.latestScanAt} now={now} />
                      <LatestScanStatus status={item.latestScanStatus} />
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-caption tabular-nums">
                    {item.scanCount30d}
                  </TableCell>
                  <TableCell className="w-[7rem] text-right">
                    <Button asChild variant="link" size="sm" className="px-0">
                      <Link href={drilldownHref(item.name)}>View host</Link>
                    </Button>
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

// Loading skeleton — used by the parent page while the first fetch is
// in flight. Mirrors the desktop column shape so the on-screen handoff
// has no jump.
const LOADING_KEYS = SKELETON_ROW_KEYS;

export function AssetsTableSkeleton() {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Host</TableHead>
          <TableHead className="w-[7rem]">Asset type</TableHead>
          <TableHead className="w-[6rem]">Open alerts</TableHead>
          <TableHead className="w-[9rem]">Unresolved alerts</TableHead>
          <TableHead className="w-[7rem]">Critical</TableHead>
          <TableHead className="w-[8rem]">Risk score</TableHead>
          <TableHead className="w-[14rem]">30-day change</TableHead>
          <TableHead className="w-[14rem]">Last activity</TableHead>
          <TableHead className="w-[14rem]">Latest scan</TableHead>
          <TableHead className="w-[8rem]">30-day scans</TableHead>
          <TableHead className="w-[7rem] text-right">Details</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {LOADING_KEYS.map((rowKey) => (
          <TableRow key={rowKey}>
            <TableCell>
              <Skeleton className="h-4 w-40" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-5 w-16" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-5 w-10" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-5 w-10" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-16" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-5 w-10" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-36" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-32" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-32" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-10" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-20" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
