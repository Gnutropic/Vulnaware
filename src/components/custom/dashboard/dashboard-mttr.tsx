// @polsia:user-owned — "Mean time to remediate" tile for the post-
// login /dashboard. Reads GET /api/dashboard/mttr via apiFetch + the
// `DashboardMttr` schema and renders a single headline number
// wrapped in `<Link href="/alerts?status=resolved">` so the click
// deep-links into the resolved view of /alerts. The link target
// flows through the existing `StatusFilterWire` enum at
// `src/lib/contracts/alerts.ts:57-64` and is parsed by
// `parseFiltersFromParams(...)` on `/alerts/page.tsx:288,294,327`,
// so no chip-row key is added.
//
// Three server-stamped numbers drive the tile:
//   - `mttrMs`       — current 30d arithmetic mean of
//                       `(Alert.remediatedAt − Alert.createdAt)` in
//                       ms. Nullable on an empty window so a brand-
//                       new install renders inert `—` instead of a
//                       fabricated `0d`.
//   - `priorMttrMs`  — the prior 30d baseline; nullable on an empty
//                       prior window. Drives the small face-up
//                       delta subtitle (`↑ / ↓ / "no change" / "no
//                       prior baseline"`). The formatter decides the
//                       copy and the unit, the server only stamps
//                       the magnitude.
//   - `sampleSize`   — current-window count. When below the
//                       SMALL_SAMPLE_THRESHOLD (5), the headline
//                       reveals a `(over N alerts)` qualifier so a
//                       single-alert answer never silently misleads.
//
// Unit-precedence ladder (the headline formatter):
//   - value >= 24h           → `"X.X days"`
//   - 1h ≤ value < 24h       → `"X.X h"`
//   - value <  1h            → `"X min"`
// Negative or `NaN` deltas fall back to `—` so a clock-skew row
// (`remediatedAt < createdAt`) never renders an inverted value.
//
// Visual rhythm mirrors `dashboard-open-by-severity.tsx` (cell
// typography: `font-display text-h3 leading-none tracking-tight`).
// State / effect / loading / error boilerplate mirrors
// `dashboard-recent-remediations.tsx:77-122` — soft-failing
// fetch + cancel-flag + per-tile `<p role="alert">` trailing
// message so the surrounding islands are untouched.

'use client';

import { Timer } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useEffect, useState } from 'react';
import { DashboardCard } from '@/components/custom/dashboard/dashboard-card';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-client';
import {
  DashboardMttr as DashboardMttrSchema,
  type DashboardMttr as DashboardMttrType,
} from '@/lib/contracts/dashboard';

// Small-sample qualifier wire posture — the headline reads
// "(over N alerts)" when the current window's count is below
// this threshold so a single-alert mean never silently misleads.
// Mirrors the brief's "over N alerts" framing. Five matches the
// "weekly digest" per-feature confidence at /api/dashboard/etc; no
// narrower threshold applies once MTTR is calculated over days.
const SMALL_SAMPLE_THRESHOLD = 5;

// ±5% "no change" copy threshold. The client owns the formatting
// (the contract surface is two nullable ms numbers), so the delta
// direction is derived from the same `mttrMs` / `priorMttrMs`
// pair the unit formatter already uses. ±5% absorbs micro-rounding
// noise between two adjacent windows.
const NO_CHANGE_RATIO = 0.05;

// `Math.round(seconds / n)` formatter — used by the headline and
// the delta-subtitle (both share the unit ladder so the same
// magnitude renders the same string 1:1).
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const totalSec = ms / 1000;
  if (totalSec >= 24 * 60 * 60) {
    return `${(totalSec / 86_400).toFixed(1)} days`;
  }
  if (totalSec >= 60 * 60) {
    return `${(totalSec / 3600).toFixed(1)} h`;
  }
  return `${Math.max(1, Math.round(totalSec / 60))} min`;
}

export function DashboardMttr(): ReactNode {
  const [data, setData] = useState<DashboardMttrType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    apiFetch('/api/dashboard/mttr', { schema: DashboardMttrSchema })
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
      data-testid="dashboard-mttr"
      aria-label="Mean time to remediate"
    >
      <DashboardCard
        title="Mean time to remediate"
        description="Average time across the last 30 days from alert creation to remediation. Click to view resolved alerts."
        action={<Timer aria-hidden="true" className="size-4 text-muted-foreground" />}
      >
        <MttrBody data={data} loading={loading} error={error} />
      </DashboardCard>
      {error ? (
        <p
          role="alert"
          className="max-w-prose text-caption text-muted-foreground"
          data-testid="dashboard-mttr-error"
        >
          Couldn’t load mean time to remediate. Other dashboard tiles are unaffected.
        </p>
      ) : null}
    </section>
  );
}

// Single-cell body — split out so the parent stays focused on
// top-level fetch state. The headline is wrapped in
// `<Link href="/alerts?status=resolved">` so the click deep-links
// into the resolved view. The `?status=resolved` query key rides
// the existing /alerts chip-row via StatusFilterWire so the
// permalink stays stable.
function MttrBody({
  data,
  loading,
  error,
}: {
  data: DashboardMttrType | null;
  loading: boolean;
  error: string | null;
}): ReactNode {
  const snapshotHref = '/alerts?status=resolved';
  const ariaLabel = 'View resolved alerts';

  if (loading) {
    return <Skeleton className="h-10 w-2/3" aria-hidden="true" />;
  }

  if (error || !data) {
    return (
      <p
        className="font-display text-h3 leading-none tracking-tight text-muted-foreground"
        data-testid="dashboard-mttr-headline"
      >
        —
      </p>
    );
  }

  if (data.mttrMs == null) {
    return (
      <div className="grid gap-1.5">
        <p
          className="font-display text-h3 leading-none tracking-tight text-muted-foreground"
          data-testid="dashboard-mttr-headline"
        >
          —
        </p>
        <p className="text-caption text-muted-foreground">
          No remediations recorded in the last 30 days.
        </p>
      </div>
    );
  }

  const currentLabel = formatDuration(data.mttrMs);
  const subtitle = formatSubtitle(data.mttrMs, data.priorMttrMs);
  const qualifiesAsSmallSample = data.sampleSize > 0 && data.sampleSize < SMALL_SAMPLE_THRESHOLD;
  const sampleQualifier =
    data.sampleSize === 1
      ? '(over 1 alert)'
      : qualifiesAsSmallSample
        ? `(over ${data.sampleSize} alerts)`
        : null;

  return (
    <div className="grid gap-1.5">
      <Link
        href={snapshotHref}
        aria-label={ariaLabel}
        data-testid="dashboard-mttr-link"
        className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
      >
        <p
          className="font-display text-h3 leading-none tracking-tight text-foreground"
          data-testid="dashboard-mttr-headline"
        >
          {currentLabel}
          {sampleQualifier ? (
            <span className="ml-2 text-caption font-normal text-muted-foreground">
              {sampleQualifier}
            </span>
          ) : null}
        </p>
      </Link>
      {subtitle ? (
        <p className="text-caption text-muted-foreground" data-testid="dashboard-mttr-subtitle">
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}

// Subtitle formatter — derived from the same `mttrMs` /
// `priorMttrMs` pair as the headline, so any rendering change to
// the headline unit-ladder flows through the subtitle 1:1.
//
// Branch order (per plan):
//   null current      → handled by the parent (no subtitle row)
//                       — defensively returns null here too.
//   null prior +      → "no prior baseline"
//     non-null current
//   both non-null,
//     within ±5%      → "no change"
//   both non-null,
//     current < prior → "↓ X.X days vs prior 30d" (faster — green)
//   both non-null,
//     current > prior → "↑ X.X days vs prior 30d" (slower — amber)
function formatSubtitle(mttrMs: number, priorMttrMs: number | null): string | null {
  if (mttrMs <= 0) return null;
  if (priorMttrMs == null) return 'no prior baseline';

  const delta = mttrMs - priorMttrMs;
  const absDelta = Math.abs(delta);
  const ratio = priorMttrMs === 0 ? 1 : absDelta / priorMttrMs;

  if (ratio < NO_CHANGE_RATIO) return 'no change';

  const direction = delta < 0 ? '↓' : '↑';
  return `${direction} ${formatDuration(absDelta)} vs prior 30d`;
}
