// @polsia:user-owned — "Recent remediations" tile for the post-login
// /dashboard. Reads GET /api/dashboard/recent-remediations via
// apiFetch + the `DashboardRecentRemediations` schema, renders up to
// 5 rows (the last 5 alerts on the caller's team with non-null
// `Alert.remediatedAt`, ordered by `remediatedAt desc`, future-
// snoozed rows excluded). Each row is a `<Link href="/alerts/[id]">`
// that opens the per-alert detail page.
//
// Visual rhythm mirrors `dashboard-top-assets.tsx`:
//   - Tile title + description (click-to-open framing) preserved.
//   - 5 static-key `<Skeleton>` rows during loading so the card
//     never flashes an authoritative "0" mid-fetch.
//   - Error: muted "—" placeholder + trailing `<p role="alert">`
//     so the surrounding islands are untouched.
//   - Empty: single muted line "No remediations yet." when
//     `items.length === 0`.
//   - Success: per-row link with finding title, owner email, and a
//     live-ticking relative stamp.
//
// 60-second tick mirrors `alert-comments-card.tsx`: timestamps
// visibly age inside the open tab without a refetch. The tick
// stores `now` in state and re-renders the relative stamp on
// every interval fire; the actual data is NOT refetched.

'use client';

import Link from 'next/link';
import { type ReactNode, useEffect, useState } from 'react';
import { DashboardCard } from '@/components/custom/dashboard/dashboard-card';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-client';
import {
  type DashboardRecentRemediationItem as DashboardRecentRemediationItemType,
  DashboardRecentRemediations as DashboardRecentRemediationsSchema,
  type DashboardRecentRemediations as DashboardRecentRemediationsType,
} from '@/lib/contracts/dashboard';

// Static skeleton row identity — fixed strings so the keys are
// stable across renders (vs an array index, which biome's
// `noArrayIndexKey` rule rejects). Five entries mirror the
// rendered list's top-N cap so the loading rhythm matches the
// card body 1:1.
const SKELETON_ROW_KEYS = [
  'recent-remediations-skel-0',
  'recent-remediations-skel-1',
  'recent-remediations-skel-2',
  'recent-remediations-skel-3',
  'recent-remediations-skel-4',
];

// 60-second tick keeps visible relative ages from going stale —
// old remediations re-evaluate "3 minutes ago" → "4 minutes ago"
// inside the open tab without a refetch. Cheap; clears on unmount.
const RELATIVE_TICK_MS = 60_000;

const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

// Relative-time formatter. Verbatim copy of the helper at
// src/components/dashboard/alert-comments-card.tsx:63-78 — defined
// locally so the tile never cross-imports the comments card. 7-tier
// bucket ladder from "seconds" up through "years".
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

export function DashboardRecentRemediations(): ReactNode {
  const [data, setData] = useState<DashboardRecentRemediationsType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Single "now" stamp drives every row's relative age — refreshed
  // on a 60s tick so old remediations visibly age inside the open
  // tab. Mount-time baseline avoids a 0→"0 seconds ago" flash on
  // first render.
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

    apiFetch('/api/dashboard/recent-remediations', {
      schema: DashboardRecentRemediationsSchema,
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
      data-testid="dashboard-recent-remediations"
      aria-label="Recent remediations"
    >
      <DashboardCard
        title="Recent remediations"
        description="Most recent alerts resolved by your team — click to open."
      >
        {loading ? (
          <div className="mt-3 grid gap-2" aria-hidden="true">
            {SKELETON_ROW_KEYS.map((rowKey) => (
              <Skeleton key={rowKey} className="h-5 w-full" />
            ))}
          </div>
        ) : error ? (
          <div className="mt-3 flex h-24 items-center justify-center text-caption text-muted-foreground">
            —
          </div>
        ) : data && data.items.length === 0 ? (
          <p className="mt-3 text-caption text-muted-foreground">No remediations yet.</p>
        ) : (
          <ul className="mt-3 grid gap-2">
            {data?.items.map((item) => (
              <RemediationRow key={item.id} item={item} now={now} />
            ))}
          </ul>
        )}
      </DashboardCard>
      {error ? (
        <p
          role="alert"
          className="max-w-prose text-caption text-muted-foreground"
          data-testid="dashboard-recent-remediations-error"
        >
          Couldn’t load recent remediations. Other dashboard tiles are unaffected.
        </p>
      ) : null}
    </section>
  );
}

// Single row — split out so the parent stays focused on top-level
// fetch state. Link target is `/alerts/[id]` always. The absolute
// ISO stamp rides the row's `title` attr so an operator hovering
// gets the wall-clock verbatim (avoids a second parse path).
function RemediationRow({
  item,
  now,
}: {
  item: DashboardRecentRemediationItemType;
  now: number;
}): ReactNode {
  const href = `/alerts/${item.id}`;
  const ariaLabel = `View remediated alert ${item.title}`;

  return (
    <li>
      <Link
        href={href}
        aria-label={ariaLabel}
        data-testid={`dashboard-recent-remediations-row-${item.id}`}
        className="flex items-center justify-between gap-3 rounded-md border border-transparent px-2 py-1.5 transition-colors hover:border-brand-500/40 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-caption text-foreground">{item.title}</span>
          <span className="truncate text-caption text-muted-foreground">
            {item.ownerEmail ?? 'Unassigned'}
          </span>
        </span>
        <span
          className="shrink-0 font-mono text-caption text-muted-foreground"
          title={item.remediatedAt}
        >
          {formatRelative(item.remediatedAt, now)}
        </span>
      </Link>
    </li>
  );
}
