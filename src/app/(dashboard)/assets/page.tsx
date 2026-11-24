// @polsia:user-owned — Assets dashboard. Client island that fetches one
// `AssetList` envelope from /api/assets via apiFetch and renders a
// per-host summary table, including each host's distinct scan count from
// the previous 30 days (Host, Asset type, Open count, unresolved-alert
// count, Critical count, 30-day scans, Last activity, drill-down link into
// /alerts?q=<host>).
// Mirrors
// alerts/page.tsx verbatim on URL persistence (lazy useState init from
// useSearchParams + router.replace on chip change with scroll:false) so
// a hard refresh rehydrates the chip row identically.
//
// Sort controls are server-driven through `?sort=…`; the resting default is
// `openCount desc`, while the table exposes unresolved-count, risk-score,
// 30-day-change, and latest-scan date directions. All sort changes use the
// same URL-preserving path as filters.
// The contract's `AssetQuery.sort` enum accepts the existing sort keys plus
// the risk-score directions; the page keeps local state in lockstep with the
// URL so a permalink with `?sort=critical` lands on a criticalCount-
// desc server response without a 400. The chip-band emits the resting
// default when no `sort` is set so a freshly-mounted tab lands clean.
//
// Hard-refresh contract: the page never uses `useEffect` post-mount to
// read `useSearchParams` — it captures the value ONCE in a lazy `useState`
// initializer. Pasting `/assets?severity=critical&status=open&sort=critical`
// into a fresh tab and hitting Enter MUST show the same chip state as
// the URL.
//
// No DB / fetch / server-only import here. /api/assets is the only
// authoritative gate; this page reads from the client via apiFetch.

'use client';

import { ChevronLeft, ChevronRight, Server } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AlertsTextQueryInput } from '@/components/dashboard/alerts-text-query-input';
import { AssetsAlertPresenceFilter } from '@/components/dashboard/assets-alert-presence-filter';
import { AssetsExportButton } from '@/components/dashboard/assets-export-button';
import { AssetsLatestScanStatusFilter } from '@/components/dashboard/assets-latest-scan-status-filter';
import { AssetsMinRiskScoreFilter } from '@/components/dashboard/assets-min-risk-score-filter';
import { AssetsNeverScannedFilter } from '@/components/dashboard/assets-never-scanned-filter';
import { AssetsRiskTrendFilter } from '@/components/dashboard/assets-risk-trend-filter';
import { AssetsScanRecencyFilter } from '@/components/dashboard/assets-scan-recency-filter';
import {
  type AssetSeverityFilter,
  AssetsSeverityChipRow,
} from '@/components/dashboard/assets-severity-chip-row';
import {
  type AssetStatusFilter,
  AssetsStatusChipRow,
} from '@/components/dashboard/assets-status-chip-row';
import { AssetsTable, AssetsTableSkeleton } from '@/components/dashboard/assets-table';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import {
  buildAssetQueryString,
  clearAssetQueryParameter,
  parseAssetPageFilters,
} from '@/lib/business/assets-url-state';
import {
  type AssetAlertPresence,
  AssetList,
  type AssetRiskTrend,
  type AssetScanRecency,
  type AssetScanStatus,
  type AssetSortKey,
} from '@/lib/contracts/assets';

// Wrap the inner island in <Suspense> so useSearchParams() doesn't escape
// to the route-level error boundary on Chromium. Next.js 16 turns the
// missing-Suspense case into an SSR/hydration throw on Chrome/Edge (V8
// hydration contract is strict), but Firefox/Safari's HTML pipeline lets
// the lazy useState init read the params without throwing — that's the
// "Chrome/Edge only" symptom we saw on vulnaware.polsia.io. The fallback
// is null while the first render is in flight so DashboardShell's own
// skeleton/redirect stays consistent.
export default function AssetsPage() {
  return (
    <Suspense fallback={null}>
      <AssetsPageInner />
    </Suspense>
  );
}

function AssetsPageInner() {
  // useSearchParams() is reactive; we only read it ONCE for the initial
  // state via the lazy useState init. After mount, local state drives.
  // Matches the alerts/page.tsx:186-207 lazy-init pattern verbatim so the
  // two pages share the same hard-refresh contract.
  const initialSearchParams = useSearchParams();
  const router = useRouter();

  const [data, setData] = useState<AssetList | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsedFilters = parseAssetPageFilters(new URLSearchParams(initialSearchParams.toString()));
  const [severity, setSeverity] = useState<AssetSeverityFilter>(() => parsedFilters.severity);
  const [status, setStatus] = useState<AssetStatusFilter>(() => parsedFilters.status);
  const [minRiskScore, setMinRiskScore] = useState<number | null>(() => parsedFilters.minRiskScore);
  const [scanRecency, setScanRecency] = useState<AssetScanRecency>(() => parsedFilters.scanRecency);
  const [latestScanStatus, setLatestScanStatus] = useState<AssetScanStatus | null>(
    () => parsedFilters.latestScanStatus,
  );
  const [neverScanned, setNeverScanned] = useState<boolean>(() => parsedFilters.neverScanned);
  const [riskTrend, setRiskTrend] = useState<AssetRiskTrend | null>(() => parsedFilters.riskTrend);
  const [alertPresence, setAlertPresence] = useState<AssetAlertPresence>(
    () => parsedFilters.alertPresence,
  );
  const [sort, setSort] = useState<AssetSortKey>(() => parsedFilters.sort);
  const currentPage = parsedFilters.page;
  const pageSize = parsedFilters.pageSize;

  const currentQuery = initialSearchParams.toString();
  const qs = useMemo(
    () =>
      buildAssetQueryString(currentQuery, {
        severity,
        status,
        minRiskScore,
        scanRecency,
        latestScanStatus,
        neverScanned,
        riskTrend,
        alertPresence,
        sort,
        page: currentPage,
        pageSize,
      }),
    [
      currentQuery,
      severity,
      status,
      minRiskScore,
      scanRecency,
      latestScanStatus,
      neverScanned,
      riskTrend,
      alertPresence,
      sort,
      currentPage,
      pageSize,
    ],
  );
  const searchQuery = initialSearchParams.get('q')?.trim() ?? '';
  const clearSearchHref = `/assets${clearAssetQueryParameter(currentQuery, 'q')}`;
  const clearMinRiskScoreHref = `/assets${clearAssetQueryParameter(currentQuery, 'minRiskScore')}`;
  const clearScanRecencyHref = `/assets${clearAssetQueryParameter(currentQuery, 'scanRecency')}`;
  const clearLatestScanStatusHref = `/assets${clearAssetQueryParameter(currentQuery, 'latestScanStatus')}`;
  const clearNeverScannedHref = `/assets${clearAssetQueryParameter(currentQuery, 'neverScanned')}`;
  const clearRiskTrendHref = `/assets${clearAssetQueryParameter(currentQuery, 'riskTrend')}`;
  const clearAlertPresenceHref = `/assets${clearAssetQueryParameter(currentQuery, 'alertPresence')}`;

  // Persist filter state into the URL on every change. `router.replace`
  // (NOT push) so the back button still leaves /assets instead of
  // stepping through every chip click.
  const updateUrl = useCallback(
    (nextQs: string) => {
      const nextUrl = `/assets${nextQs}`;
      if (`${window.location.pathname}${window.location.search}` !== nextUrl) {
        router.replace(nextUrl, { scroll: false });
      }
    },
    [router],
  );

  const changePage = useCallback(
    (nextPage: number) => {
      const params = new URLSearchParams(qs);
      if (nextPage <= 1) params.delete('page');
      else params.set('page', String(nextPage));
      const search = params.toString();
      updateUrl(search ? `?${search}` : '');
    },
    [qs, updateUrl],
  );

  useEffect(() => {
    updateUrl(qs);
  }, [qs, updateUrl]);

  useEffect(() => {
    let active = true;
    apiFetch(`/api/assets${qs}`, { schema: AssetList })
      .then((payload) => {
        if (active) setData(payload);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        if (!active) return;
        setError(msg);
        toast.error('Could not load assets.');
      });
    return () => {
      active = false;
    };
  }, [qs]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium text-muted-foreground">
          <Server className="mr-1.5 inline size-4 align-[-0.18em] text-brand-500" />
          Assets
        </p>
        <h1 className="font-display text-h1 tracking-tight text-foreground">Assets</h1>
        <p className="max-w-prose text-body-lg text-muted-foreground">
          Per-host rollup of alerts in your team. Each row aggregates the total open alerts, the
          critical-alert count, risk score, asset type, distinct scans from the previous 30 days,
          the latest scan outcome and timestamp, and the most-recent-activity timestamp. Click a row
          to drill into alerts for that host.
        </p>
      </header>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load assets</AlertTitle>
          <AlertDescription className="font-mono text-caption">{error}</AlertDescription>
        </Alert>
      ) : null}

      <section
        aria-label="Search assets"
        className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center"
      >
        <AlertsTextQueryInput
          key={currentQuery}
          initialValue={initialSearchParams.get('q') ?? ''}
          basePath="/assets"
          inputId="assets-hostname-search"
          label="Search assets by hostname"
          placeholder="Search hostname…"
          clearLabel="Clear hostname search"
          preserveSelection
        />
        <AssetsMinRiskScoreFilter value={minRiskScore} onChange={setMinRiskScore} />
        <AssetsScanRecencyFilter value={scanRecency} onChange={setScanRecency} />
        <AssetsLatestScanStatusFilter value={latestScanStatus} onChange={setLatestScanStatus} />
        <AssetsNeverScannedFilter value={neverScanned} onChange={setNeverScanned} />
        <AssetsRiskTrendFilter
          value={riskTrend ?? 'all'}
          onChange={(next) => setRiskTrend(next === 'all' ? null : next)}
        />
        <AssetsAlertPresenceFilter value={alertPresence} onChange={setAlertPresence} />
      </section>

      <AssetsSeverityChipRow value={severity} onChange={setSeverity} />
      <AssetsStatusChipRow value={status} onChange={setStatus} />

      <div className="flex flex-wrap items-center justify-end gap-3">
        <AssetsExportButton
          q={searchQuery}
          severity={severity}
          status={status}
          minRiskScore={minRiskScore}
          scanRecency={scanRecency}
          latestScanStatus={latestScanStatus}
          neverScanned={neverScanned}
          riskTrend={riskTrend}
          alertPresence={alertPresence}
          sort={sort}
          disabled={!data}
        />
      </div>

      {!data && !error ? <AssetsTableSkeleton /> : null}

      {data ? (
        <AssetsTable
          items={data.items}
          sort={sort}
          onSortChange={setSort}
          query={searchQuery}
          clearQueryHref={clearSearchHref}
          minRiskScore={minRiskScore}
          clearMinRiskScoreHref={clearMinRiskScoreHref}
          scanRecency={scanRecency}
          latestScanStatus={latestScanStatus}
          neverScanned={neverScanned}
          riskTrend={riskTrend}
          alertPresence={alertPresence}
          clearScanRecencyHref={clearScanRecencyHref}
          clearLatestScanStatusHref={clearLatestScanStatusHref}
          clearNeverScannedHref={clearNeverScannedHref}
          clearRiskTrendHref={clearRiskTrendHref}
          clearAlertPresenceHref={clearAlertPresenceHref}
        />
      ) : null}

      {data && (data.total > pageSize || currentPage > 1) ? (
        <nav
          aria-label="Assets pagination"
          className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-caption text-muted-foreground" aria-live="polite">
            {data.items.length === 0
              ? `No hosts on this page of ${data.total}`
              : `Showing ${(currentPage - 1) * pageSize + 1}–${Math.min(currentPage * pageSize, data.total)} of ${data.total} hosts`}
            <span className="ml-2">
              Page {currentPage} of {Math.max(1, Math.ceil(data.total / pageSize))}
            </span>
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => changePage(currentPage - 1)}
              disabled={currentPage <= 1}
              aria-label="Previous assets page"
            >
              <ChevronLeft aria-hidden="true" />
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => changePage(currentPage + 1)}
              disabled={currentPage >= Math.max(1, Math.ceil(data.total / pageSize))}
              aria-label="Next assets page"
            >
              Next
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        </nav>
      ) : null}
    </div>
  );
}
