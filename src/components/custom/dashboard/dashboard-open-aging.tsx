// @polsia:user-owned — Open-alerts aging widget for the post-login /
// dashboard. Reads GET /api/dashboard/aging via apiFetch + the
// `DashboardOpenAging` schema, renders four age buckets (≤7d, 8–30d,
// 31–90d, >90d) as a 4-column responsive grid below the existing
// 4-tile stat row. Each bucket card is itself a `<Link href=
// "/alerts?status=open&from=...&to=...">` so a click navigates into
// /alerts pre-filtered to that bucket's createdAt window — the
// /alerts page already parses `status` via its `AlertQuery` schema
// and narrows `createdAt` server-side via `createdAt: { gte, lte }`,
// so the URL pre-fill is wired end-to-end without a chip-row change.
//
// Loading / error / empty posture matches `dashboard-stats-row.tsx`:
//   - Loading : per-bucket `<Skeleton>` so the widget never flashes
//               an authoritative "0" mid-fetch (counts can legitimately
//               be 0 on a brand-new team).
//   - Error   : per-bucket inert "—" placeholder + a single trailing
//               inline `<p role="alert">`; the widget never throws.
//   - Success : bucket body = `<p className="text-display …">{count}</p>`.
//
// `now` (today, the bucket link anchor) is computed ONCE on mount via
// `useMemo(() => Date.now(), [])` so all four bucket links share a
// single wall-clock anchor and the bucket boundaries match what the
// server stamped from its `new Date()` default on the same mount.

'use client';

import { Clock } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { DashboardCard } from '@/components/custom/dashboard/dashboard-card';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-client';
import { DashboardOpenAging as DashboardOpenAgingSchema } from '@/lib/contracts/dashboard';

interface AgingState {
  le7d: number;
  d8to30: number;
  d31to90: number;
  gt90d: number;
}

interface BucketSpec {
  key: 'le7d' | 'd8to30' | 'd31to90' | 'gt90d';
  title: string;
  description: string;
  ariaSuffix: string;
}

// Today's date as a yyyy-mm-dd slice — the (open) alerts page's
// `from` / `to` URL keys expect ISO date slices (not full UTC ms),
// parsed server-side via `new Date(sp.get('from') ?? '')`. Mirrors
// the slice the date-input on /alerts writes.
const MS_PER_DAY = 86_400_000;
function isoDate(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

const BUCKETS: BucketSpec[] = [
  {
    key: 'le7d',
    title: '≤ 7d',
    description: '0–7 days old',
    ariaSuffix: '≤ 7d bucket',
  },
  {
    key: 'd8to30',
    title: '8–30d',
    description: '8–30 days old',
    ariaSuffix: '8–30d bucket',
  },
  {
    key: 'd31to90',
    title: '31–90d',
    description: '31–90 days old',
    ariaSuffix: '31–90d bucket',
  },
  {
    key: 'gt90d',
    title: '> 90d',
    description: 'Older than 90 days',
    ariaSuffix: '> 90d bucket',
  },
];

export function DashboardOpenAging(): ReactNode {
  const [state, setState] = useState<AgingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // TODAY stamped once on mount from a useMemo whose dep list is
  // empty — all four bucket links share a single wall-clock anchor so
  // a same-day bucket click never lands the operator in a window
  // that drifts from the count they just clicked on. The route's
  // `new Date()` and this client's mount-time are the same window
  // (a fetch lands within seconds of mount), so the link edges and
  // the count predicate agree.
  const todayMs = useMemo(() => Date.now(), []);
  const todayIso = useMemo(() => isoDate(todayMs), [todayMs]);
  const minusIso = useMemo(() => (days: number) => isoDate(todayMs - days * MS_PER_DAY), [todayMs]);

  const bucketLinks = useMemo(
    () => ({
      // `≤7d` — upper edge is today (inclusive). Server predicate is
      // `createdAt >= now - 7d`; the date-slice parity with the
      // /alerts "Last 7d" chip (from = daysAgo(7), to = today).
      le7d: `/alerts?status=open&from=${minusIso(7)}&to=${todayIso}`,
      // `8–30d` — upper edge stops at the day BEFORE the 7d bound
      // (`minusIso(8)`) so the two bucket URLs do NOT overlap on a
      // same-day row. The /alerts route narrows `createdAt: { lte:
      // to }` (inclusive), so `to = minusIso(7)` itself would let the
      // boundary row at `now - 7d` appear in BOTH bucket views; the
      // `minusIso(8)` shortcut keeps the visible-row windows
      // disjoint while still aligning with the day-granularity of
      // the /alerts date input.
      d8to30: `/alerts?status=open&from=${minusIso(30)}&to=${minusIso(8)}`,
      // `31–90d` — same exclusion form: `to = minusIso(31)` keeps
      // the 30-day-boundary row in `8–30d` (per the inclusive lower
      // edge of that bucket) and out of this view.
      d31to90: `/alerts?status=open&from=${minusIso(90)}&to=${minusIso(31)}`,
      // `>90d` — lower bound open: omit `from` so the /alerts parser
      // treats it as "no lower bound" (mirror of /alerts without a
      // typed date range). Upper edge stops at the day BEFORE the
      // 90d bound (`minusIso(91)`) so a row at exactly `now - 90d`
      // stays in `31–90d` and out of this view.
      gt90d: `/alerts?status=open&to=${minusIso(91)}`,
    }),
    [minusIso, todayIso],
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    apiFetch('/api/dashboard/aging', { schema: DashboardOpenAgingSchema })
      .then((payload) => {
        if (!active) return;
        setState(payload);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        // Soft-fail — the widget renders inert placeholders so the
        // page still works. The stats row above and recent activity
        // below are independently fetched and unaffected.
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
      className="grid gap-4"
      data-testid="dashboard-open-aging"
      aria-label="Open alerts by age"
    >
      <DashboardCard
        title="Open by age"
        description="Currently open alerts, broken out by how long they’ve been open."
        action={<Clock aria-hidden="true" className="size-4 text-muted-foreground" />}
      >
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {BUCKETS.map((bucket) => {
            const href = bucketLinks[bucket.key];
            // Bucket card body — a clickable wrapper that navigates
            // into /alerts pre-filtered to this bucket's createdAt
            // window. The card itself is the link so the whole tile
            // (count + title + description) is hit-target; the
            // aria-label carries the bucket name + count together so
            // screen readers announce both on focus.
            const bucketCount = state ? state[bucket.key] : null;
            const ariaLabel =
              bucketCount != null
                ? `View open alerts in the ${bucket.ariaSuffix} (${bucketCount})`
                : `View open alerts in the ${bucket.ariaSuffix}`;
            const cardInner = (
              <DashboardCard
                title={bucket.title}
                description={bucket.description}
                className="border-border/60 transition-colors hover:border-brand-500/60 hover:bg-muted/40 focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
              >
                {loading ? (
                  <Skeleton className="h-10 w-2/3" aria-hidden="true" />
                ) : bucketCount != null ? (
                  <p
                    className="font-display text-h3 leading-none tracking-tight text-foreground"
                    data-testid={`dashboard-open-aging-count-${bucket.key}`}
                  >
                    {bucketCount.toLocaleString()}
                  </p>
                ) : (
                  <p
                    role="alert"
                    className="font-display text-h3 leading-none tracking-tight text-muted-foreground"
                  >
                    —
                  </p>
                )}
              </DashboardCard>
            );
            return (
              <Link
                key={bucket.key}
                href={href}
                aria-label={ariaLabel}
                className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
                data-testid={`dashboard-open-aging-link-${bucket.key}`}
              >
                {cardInner}
              </Link>
            );
          })}
        </div>
      </DashboardCard>
      {error ? (
        <p
          role="alert"
          className="max-w-prose text-caption text-muted-foreground"
          data-testid="dashboard-open-aging-error"
        >
          Couldn’t load open alerts aging. Stats row and recent activity are unaffected.
        </p>
      ) : null}
    </section>
  );
}
