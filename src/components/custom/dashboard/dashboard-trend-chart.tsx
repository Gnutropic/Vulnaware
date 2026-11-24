// @polsia:user-owned — Alert-volume trend chart for the post-login
// /dashboard. Reads GET /api/dashboard/trend via apiFetch + the
// `DashboardTrend` schema, renders the LAST 14 LOCAL DAYS as a two-
// series inline SVG bar chart: alerts opened per day (teal / brand)
// vs alerts resolved per day (emerald). No chart library — the SVG
// is hand-rolled so the chart never drags in a heavyweight
// dependency for a 14-day tile.
//
// **LOCAL day bucketing happens here, on the client.** The server
// returns the raw event row list (each row's `createdAt` +
// `closedAt`) so we can bucket by the user's `Intl` timezone. If
// the bucketing were moved to the server, every non-UTC caller
// would see a chart rounded to UTC and silently misattributed. The
// helper `bucketEventsByLocalDay` is a pure function (events +
// todayMs → 14-element array) co-located in this file so it can be
// exercised in isolation.
//
// Loading / error / empty posture mirrors the sibling islands:
//   - Loading : 14 per-day `<Skeleton>` rows (a single full-width
//               bar-shaped skeleton would also work; per-day
//               matches the rendered card's rhythm and never
//               flashes an authoritative "0" mid-fetch).
//   - Error   : single trailing `<p role="alert">`; the widget
//               never throws and other islands are untouched.
//   - All-zero: chart renders with all-zero bars + a subtitle
//               "No opens or resolves recorded in the last 14 days."
//   - Success : inline `<svg viewBox=…>` with one group per day,
//               two `<rect>` bars per group (opened, resolved),
//               shared Y-max across the 14-day window.
//
// A11y:
//   - SVG `aria-label` summarises the chart's purpose.
//   - Each `<rect>` carries a `<title>` child so hover-and-screen-
//     reader announcements are equivalent ("Jul 22: 3 opened,
//     5 resolved").
//   - A small inline legend ("■ Opened ■ Resolved") decodes the
//     colors without hover.

'use client';

import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { DashboardCard } from '@/components/custom/dashboard/dashboard-card';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-client';
import {
  DashboardTrend as DashboardTrendSchema,
  type DashboardTrend as DashboardTrendType,
} from '@/lib/contracts/dashboard';

const MS_PER_DAY = 86_400_000;
const DAY_COUNT = 14;

// Tailwind palette stops, exposed as utility classes that the
// SVG can pick up via `className`. Using `bg-*` on the legend chips
// (DOM elements) and `fill-*` on the SVG rect elements keeps both
// surfaces on the same already-curated palette. No hex invented.
const OPENED_INDICATOR_CLASS = 'bg-teal-600';
const OPENED_BAR_FILL_CLASS = 'fill-teal-600';
const RESOLVED_INDICATOR_CLASS = 'bg-emerald-600';
const RESOLVED_BAR_FILL_CLASS = 'fill-emerald-600';
const GRID_LINE_CLASS = 'stroke-slate-400/30';
const AXIS_LABEL_CLASS = 'fill-muted-foreground';

interface TrendEvent {
  id: string;
  createdAt: string;
  closedAt: string | null;
}

interface DayBucket {
  dayStartMs: number;
  dayLabel: string;
  dayKey: string;
  isoDate: string;
  opened: number;
  resolved: number;
}

// Pure helper — extracted so it can be unit-tested without the
// React tree. Walks the last `DAY_COUNT` local days newest-first,
// bucket by LOCAL date (using `Intl`-derived midnight via
// `new Date(year, month, day)`) so a non-UTC user sees a chart
// that honours their wall clock.
function bucketEventsByLocalDay(events: TrendEvent[], todayMs: number): DayBucket[] {
  // The reference day = today at midnight, computed from the user's
  // local calendar (the constructor reads local-zone fields, so
  // `new Date(2024, 6, 22)` is the user's "July 22 00:00").
  const todayDate = new Date(todayMs);
  const todayMidnight = new Date(
    todayDate.getFullYear(),
    todayDate.getMonth(),
    todayDate.getDate(),
  );

  // Initialise an array of length DAY_COUNT — newest day at index
  // (DAY_COUNT - 1), oldest at index 0. Day-key reads uniquely per
  // local-day so an event's `createdAt` lands in exactly one bucket.
  const buckets: DayBucket[] = [];
  for (let i = 0; i < DAY_COUNT; i++) {
    // `i` days ago — negative offset back in time.
    const dayStartMs = todayMidnight.getTime() - (DAY_COUNT - 1 - i) * MS_PER_DAY;
    const day = new Date(dayStartMs);
    buckets.push({
      dayStartMs,
      dayLabel: day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      dayKey: `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`,
      isoDate: day.toISOString().slice(0, 10),
      opened: 0,
      resolved: 0,
    });
  }

  // O(1) lookup by yyyy-mm-dd key.
  const bucketByKey = new Map<string, DayBucket>();
  for (const b of buckets) bucketByKey.set(b.dayKey, b);

  // Iterate events; `createdAt` and `closedAt` may each fall
  // inside or outside the window — those that fall outside simply
  // don't contribute (the server already pre-filtered, but the
  // client defense-in-depth narrows again).
  const windowStartMs = buckets[0]?.dayStartMs ?? todayMidnight.getTime();
  for (const ev of events) {
    const createdMs = Date.parse(ev.createdAt);
    if (!Number.isNaN(createdMs) && createdMs >= windowStartMs) {
      const createdLocalKey = localDayKey(createdMs);
      const bucket = bucketByKey.get(createdLocalKey);
      if (bucket) bucket.opened += 1;
    }
    if (ev.closedAt) {
      const closedMs = Date.parse(ev.closedAt);
      if (!Number.isNaN(closedMs) && closedMs >= windowStartMs) {
        const closedLocalKey = localDayKey(closedMs);
        const bucket = bucketByKey.get(closedLocalKey);
        if (bucket) bucket.resolved += 1;
      }
    }
  }
  return buckets;
}

// yyyy-mm-dd in the user's local calendar — `Intl`-derived.
function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function DashboardTrendChart(): ReactNode {
  const [trend, setTrend] = useState<DashboardTrendType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Today stamped once on mount from a `useMemo` whose dep list is
  // empty — all 14 days share a single wall-clock anchor. Mirrors
  // `DashboardOpenAging`'s posture exactly.
  const todayMs = useMemo(() => Date.now(), []);

  // Stable per-day skeleton keys: derived from the today anchor
  // so each row's id is the yyyy-mm-dd string the bucketing
  // helper produces for the same day. Stable id keys (vs. an
  // array index) keep React from remounting the skeleton rows on
  // any other re-render of the surrounding card.
  const skeletonRows = useMemo(
    () =>
      Array.from({ length: DAY_COUNT }).map((_, i) => {
        const d = new Date(todayMs - (DAY_COUNT - 1 - i) * MS_PER_DAY);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        return { key, label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) };
      }),
    [todayMs],
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    apiFetch('/api/dashboard/trend', { schema: DashboardTrendSchema })
      .then((payload) => {
        if (!active) return;
        setTrend(payload);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        // Soft-fail — the tile renders inert so the page still
        // works. The stats row above and recent activity below
        // are independently fetched and unaffected.
        const msg = err instanceof Error ? err.message : 'Unknown error';
        setError(msg);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // Pure bucketing — runs on every render with new `trend`, but
  // memoised on the event-list reference + the today anchor so
  // the same input never recomputes.
  const buckets = useMemo(
    () => bucketEventsByLocalDay(trend?.events ?? [], todayMs),
    [trend, todayMs],
  );

  return (
    <section
      className="grid gap-3"
      data-testid="dashboard-trend-chart"
      aria-label="Alert volume trend"
    >
      <DashboardCard
        title="Alert volume — last 14 days"
        description="Daily opens vs closes across your team."
      >
        <div className="flex flex-wrap items-center gap-3 text-caption">
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span
              aria-hidden
              className={`inline-block size-2.5 rounded-sm ${OPENED_INDICATOR_CLASS}`}
            />
            Opened
          </span>
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span
              aria-hidden
              className={`inline-block size-2.5 rounded-sm ${RESOLVED_INDICATOR_CLASS}`}
            />
            Resolved
          </span>
        </div>
        {loading ? (
          <div className="mt-4 grid gap-1" aria-hidden="true">
            {skeletonRows.map((row) => (
              // Per-day skeleton rows so the loading rhythm mirrors
              // the rendered chart columns 1:1 — never a flash of
              // an authoritative "0".
              <Skeleton key={row.key} className="h-3 w-full" />
            ))}
          </div>
        ) : error ? (
          // Error is also the trailing alert paragraph below; the
          // card body shows a muted placeholder so the card chrome
          // doesn't collapse to nothing on a transient fetch fail.
          <div className="mt-4 flex h-24 items-center justify-center text-caption text-muted-foreground">
            —
          </div>
        ) : (
          <TrendChartBody buckets={buckets} />
        )}
        {/* "No opens or resolves recorded in the last 14 days." —
            only shown when the entire window is all-zero (true
            empty). The y-axis is still rendered so the chart reads
            as a chart, not a panel of text. */}
        {!loading && !error && buckets.every((b) => b.opened === 0 && b.resolved === 0) ? (
          <p className="mt-2 text-caption text-muted-foreground">
            No opens or resolves recorded in the last 14 days.
          </p>
        ) : null}
      </DashboardCard>
      {error ? (
        <p
          role="alert"
          className="max-w-prose text-caption text-muted-foreground"
          data-testid="dashboard-trend-chart-error"
        >
          Couldn’t load alert trend. Stats row and recent activity are unaffected.
        </p>
      ) : null}
    </section>
  );
}

// Inner render — split out so the parent stays focused on fetch
// state and the SVG-layout math sits in a focused helper.
function TrendChartBody({ buckets }: { buckets: DayBucket[] }): ReactNode {
  // Shared Y-max across the whole chart — picks the max of all
  // per-day bars so the tallest bar always fills the chart
  // vertically and shorter bars sit visibly lower.
  const yMax = Math.max(1, ...buckets.flatMap((b) => [b.opened, b.resolved]));

  const viewBoxWidth = 640;
  const viewBoxHeight = 160;
  // Padding leaves room above the tallest bar for a visual cap and
  // below for the day-labels row.
  const chartTop = 12;
  const chartBottom = 132;
  const chartHeight = chartBottom - chartTop;

  const slotWidth = viewBoxWidth / buckets.length;
  // Bar pair width per slot — leaves a gap between adjacent days
  // so the per-day column reads clearly.
  const barWidth = Math.max(4, slotWidth * 0.36);
  const barGap = Math.max(2, slotWidth * 0.08);

  // Four horizontal grid ticks — 0%, 25%, 50%, 100% of the y-axis.
  // Light lines so the chart feels data-dense without dominating.
  const gridTicks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="mt-3 overflow-x-auto">
      <svg
        viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeight}`}
        role="img"
        aria-label={`Alerts opened and resolved per day, last ${DAY_COUNT} days`}
        className="h-40 w-full min-w-[480px]"
      >
        <title>Alerts opened and resolved per day, last {DAY_COUNT} days</title>
        {gridTicks.map((tick) => {
          const y = chartBottom - tick * chartHeight;
          return (
            <line
              key={`grid-${tick}`}
              x1={0}
              x2={viewBoxWidth}
              y1={y}
              y2={y}
              className={GRID_LINE_CLASS}
              strokeWidth={tick === 0 ? 1 : 0.5}
              strokeDasharray={tick === 0 ? undefined : '2 2'}
            />
          );
        })}
        {buckets.map((bucket, i) => {
          const slotCenter = i * slotWidth + slotWidth / 2;
          const openedHeight = (bucket.opened / yMax) * chartHeight;
          const resolvedHeight = (bucket.resolved / yMax) * chartHeight;
          const openedY = chartBottom - openedHeight;
          const resolvedY = chartBottom - resolvedHeight;
          return (
            <g key={bucket.dayKey} data-testid={`dashboard-trend-chart-day-${bucket.dayKey}`}>
              <rect
                x={slotCenter - barWidth - barGap / 2}
                y={openedY}
                width={barWidth}
                height={openedHeight}
                className={OPENED_BAR_FILL_CLASS}
                rx={1}
              >
                <title>{`${bucket.dayLabel}: ${bucket.opened} opened`}</title>
              </rect>
              <rect
                x={slotCenter + barGap / 2}
                y={resolvedY}
                width={barWidth}
                height={resolvedHeight}
                className={RESOLVED_BAR_FILL_CLASS}
                rx={1}
              >
                <title>{`${bucket.dayLabel}: ${bucket.resolved} resolved`}</title>
              </rect>
              <text
                x={slotCenter}
                y={viewBoxHeight - 8}
                fontSize={9}
                textAnchor="middle"
                className={AXIS_LABEL_CLASS}
              >
                {bucket.dayLabel}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
