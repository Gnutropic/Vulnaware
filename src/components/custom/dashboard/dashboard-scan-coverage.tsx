// @polsia:user-owned — "Scan coverage" tile for the post-login
// /dashboard. Reads GET /api/dashboard/scan-coverage via apiFetch +
// the `DashboardScanCoverage` schema and renders three summary
// cells inside `DashboardCard` chrome mirroring the `open-by-
// severity` cell typography (`font-display text-h3 leading-none
// tracking-tight`):
//   - Total scanned hosts      — `totalHosts` from the team's
//                                distinct `Alert.finding.asset.host`
//                                reduce.
//   - Hosts with open alerts   — `hostsWithOpenAlerts`, the sub-
//                                count of those hosts with
//                                `openCount >= 1` (severity NOT
//                                weighted — see loader header).
//   - Last scan activity       — team's freshest contributing
//                                stamp (`lastScanActivityAt`), with
//                                a 60-second tick that visibly ages
//                                the relative stamp without a
//                                refetch. Falsy stamp renders the
//                                copy "No scan activity yet." instead
//                                of fabricating a date.
//
// Visual rhythm mirrors `dashboard-open-by-severity.tsx` (cell
// typography), `dashboard-recent-remediations.tsx` (state / effect /
// loading / error boilerplate + 60s tick + `formatRelative` helper).
// Loading / error / empty posture matches the surrounding tiles:
//   - Loading : per-cell `<Skeleton>` so the widget never flashes an
//               authoritative "0" mid-fetch (counts can legitimately
//               be 0 on a brand-new team).
//   - Error   : per-cell inert "—" placeholder + a single trailing
//               inline `<p role="alert">`; the widget never throws.
//   - Success : cell body = `<p className="text-display …">{count}</p>`
//               for the two numeric cells, plus a hover-title ISO
//               date for the relative-stamp cell.

'use client';

import { ScanSearch } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { DashboardCard } from '@/components/custom/dashboard/dashboard-card';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-client';
import {
  DashboardScanCoverage as DashboardScanCoverageSchema,
  type DashboardScanCoverage as DashboardScanCoverageType,
} from '@/lib/contracts/dashboard';

interface CellSpec {
  key: 'total' | 'open' | 'last';
  label: string;
  testid: string;
}

// Static cell identity — fixed strings so the keys are stable
// across renders (vs an array index, which biome's `noArrayIndexKey`
// rule rejects).
const CELLS: CellSpec[] = [
  { key: 'total', label: 'Total scanned hosts', testid: 'scan-coverage-total' },
  { key: 'open', label: 'Hosts with open alerts', testid: 'scan-coverage-open' },
  { key: 'last', label: 'Last scan activity', testid: 'scan-coverage-last' },
];

// 60-second tick keeps visible relative ages from going stale —
// the last-scan-activity stamp visibly ages inside the open tab
// without a refetch. Mirrors `dashboard-recent-remediations.tsx` so
// the two live-ticking tiles age in lockstep.
const RELATIVE_TICK_MS = 60_000;

const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

// Relative-time formatter. Verbatim copy of the helper at
// `dashboard-recent-remediations.tsx:62-75` — defined locally so the
// tile never cross-imports the remediations file. 7-tier bucket
// ladder from "seconds" up through "years".
function formatRelative(value: string, now: number): string {
  const d = new Date(value);
  const ts = d.getTime();
  if (Number.isNaN(ts)) return '—';
  const deltaSec = Math.round((ts - now) / 1000);
  const abs = Math.abs(deltaSec);
  if (abs < 45) return RTF.format(deltaSec, 'second');
  if (abs < 45 * 60) return RTF.format(Math.round(deltaSec / 60), 'minute');
  if (abs < 22 * 60 * 60) return RTF.format(Math.round(deltaSec / 3600), 'hour');
  if (abs < 26 * 24 * 60 * 60) return RTF.format(Math.round(deltaSec / 86_400), 'day');
  if (abs < 320 * 24 * 60 * 60) return RTF.format(Math.round(deltaSec / (7 * 86_400)), 'week');
  if (abs < 365 * 24 * 60 * 60) return RTF.format(Math.round(deltaSec / (30 * 86_400)), 'month');
  return RTF.format(Math.round(deltaSec / (365 * 86_400)), 'year');
}

export function DashboardScanCoverage(): ReactNode {
  const [data, setData] = useState<DashboardScanCoverageType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Single "now" stamp drives the last-scan-activity relative age —
  // refreshed on a 60s tick so old stamps visibly age inside the
  // open tab. Mount-time baseline avoids a 0→"0 seconds ago" flash
  // on first render.
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const handle = setInterval(() => {
      setNow(Date.now());
    }, RELATIVE_TICK_MS);
    return () => {
      clearInterval(handle);
    };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    apiFetch('/api/dashboard/scan-coverage', {
      schema: DashboardScanCoverageSchema,
    })
      .then((envelope) => {
        if (!active) return;
        setData(envelope);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        // Soft-fail — the tile renders inert placeholders so the
        // page still works. Stats row, top-assets, and recent-
        // activity tiles are independently fetched and unaffected.
        const msg = err instanceof Error ? err.message : 'Unknown error';
        setError(msg);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <section
      className="grid gap-3"
      data-testid="dashboard-scan-coverage"
      aria-label="Scan coverage"
    >
      <DashboardCard
        title="Scan coverage"
        description="Hosts seen by your current scanner, and how many still have open alerts."
        action={<ScanSearch aria-hidden="true" className="size-4 text-muted-foreground" />}
      >
        <div className="grid gap-6 md:grid-cols-3">
          {CELLS.map((cell) => (
            <Cell
              key={cell.key}
              cell={cell}
              data={data}
              loading={loading}
              error={error}
              now={now}
            />
          ))}
        </div>
      </DashboardCard>
      {error ? (
        <p
          role="alert"
          className="max-w-prose text-caption text-muted-foreground"
          data-testid="dashboard-scan-coverage-error"
        >
          Couldn’t load scan coverage. Other dashboard tiles are unaffected.
        </p>
      ) : null}
    </section>
  );
}

// Single cell — split out so the parent stays focused on top-level
// fetch state. The last-activity cell uses the live-ticking `now`
// value; the two numeric cells ignore it. Cell body mirrors
// `dashboard-open-by-severity.tsx` cell typography (`font-display
// text-h3 leading-none tracking-tight`).
function Cell({
  cell,
  data,
  loading,
  error,
  now,
}: {
  cell: CellSpec;
  data: DashboardScanCoverageType | null;
  loading: boolean;
  error: string | null;
  now: number;
}): ReactNode {
  const isLast = cell.key === 'last';
  const stamp = data?.lastScanActivityAt ?? null;

  // Numeric cells: 0 is a valid (non-loading) value, so we gate on
  // the absence of `data`, not the falsiness of the count.
  const numericValue =
    !isLast && data ? (cell.key === 'total' ? data.totalHosts : data.hostsWithOpenAlerts) : null;

  return (
    <div className="grid gap-1.5">
      <p className="text-eyebrow text-muted-foreground">{cell.label}</p>
      {loading ? (
        <Skeleton className="h-10 w-2/3" aria-hidden="true" />
      ) : error ? (
        <p
          className="font-display text-h3 leading-none tracking-tight text-muted-foreground"
          data-testid={cell.testid}
        >
          —
        </p>
      ) : isLast ? (
        stamp == null ? (
          <p
            className="font-display text-h3 leading-none tracking-tight text-muted-foreground"
            data-testid={cell.testid}
          >
            No scan activity yet.
          </p>
        ) : (
          <p
            className="font-display text-h3 leading-none tracking-tight text-foreground"
            data-testid={cell.testid}
            title={stamp}
          >
            {formatRelative(stamp, now)}
          </p>
        )
      ) : (
        <p
          className="font-display text-h3 leading-none tracking-tight text-foreground"
          data-testid={cell.testid}
        >
          {numericValue != null ? numericValue.toLocaleString() : '—'}
        </p>
      )}
    </div>
  );
}
