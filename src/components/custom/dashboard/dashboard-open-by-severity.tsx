// @polsia:user-owned — Open-alerts-by-severity widget for the post-
// login /dashboard. Reads GET /api/dashboard/open-by-severity via
// apiFetch + the `DashboardOpenBySeverityCounts` schema and renders
// four severity cells (Critical / High / Medium / Low) as a 4-column
// responsive grid. Each cell is itself a `<Link href="/alerts?status=
// open&severity=<level>">` so a click deep-links into /alerts pre-
// filtered to that severity — /alerts already parses `severity` via
// its `AlertQuery` schema, so the URL pre-fill is wired end-to-end
// without a chip-row change.
//
// Tile-side predicate (server, in `loadOpenAlertCountsBySeverity`)
// is `status='open' AND remediatedAt IS NULL AND OR[snoozedUntil IS
// NULL, snoozedUntil <= now]`. /alerts click-through predicate does
// NOT include `remediated`: a remediated-but-still-status=open row
// may contribute to the click-through view even though it is not
// reflected in the tile count — this asymmetry is intentional
// (brief specifies it).
//
// Loading / error / empty posture matches `dashboard-open-aging.tsx`:
//   - Loading : per-cell `<Skeleton>` so the widget never flashes an
//               authoritative "0" mid-fetch (counts can legitimately
//               be 0 on a brand-new team).
//   - Error   : per-cell inert "—" placeholder + a single trailing
//               inline `<p role="alert">`; the widget never throws.
//   - Success : cell body = `<p className="text-display …">{count}</p>`.

'use client';

import { ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useEffect, useState } from 'react';
import { DashboardCard } from '@/components/custom/dashboard/dashboard-card';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-client';
import { DashboardOpenBySeverityCounts as DashboardOpenBySeverityCountsSchema } from '@/lib/contracts/dashboard';
import { severityColorToken } from '@/lib/ui/severity-colors';

interface SeverityState {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

interface SeveritySpec {
  key: keyof SeverityState;
  label: string;
  deepLinkValue: string;
  ariaSuffix: string;
  description: string;
}

// Canonical wire-order for the four severity buckets. Mirrors
// `SEVERITY_RANK` in src/lib/business/alerts-severity.ts so the
// tile's emitted order matches the chip-row's emitted order and a
// permalink from a chip lands on /alerts with the matching severity
// chip already active.
const SEVERITIES: SeveritySpec[] = [
  {
    key: 'critical',
    label: 'Critical',
    deepLinkValue: 'critical',
    ariaSuffix: 'Critical bucket',
    description: 'Severe — needs immediate action',
  },
  {
    key: 'high',
    label: 'High',
    deepLinkValue: 'high',
    ariaSuffix: 'High bucket',
    description: 'High-impact — schedule soon',
  },
  {
    key: 'medium',
    label: 'Medium',
    deepLinkValue: 'medium',
    ariaSuffix: 'Medium bucket',
    description: 'Moderate — track on the queue',
  },
  {
    key: 'low',
    label: 'Low',
    deepLinkValue: 'low',
    ariaSuffix: 'Low bucket',
    description: 'Low-impact — backlog',
  },
];

export function DashboardOpenBySeverity(): ReactNode {
  const [state, setState] = useState<SeverityState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    apiFetch('/api/dashboard/open-by-severity', { schema: DashboardOpenBySeverityCountsSchema })
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
    <section aria-label="Open alerts by severity" data-testid="dashboard-open-by-severity">
      <DashboardCard
        title="Open by severity"
        description="Currently open, unremediated, non-snoozed alerts grouped by severity."
        action={<ShieldAlert aria-hidden="true" className="size-4 text-muted-foreground" />}
      >
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {SEVERITIES.map((severity) => {
            const href = `/alerts?status=open&severity=${severity.deepLinkValue}`;
            const cellCount = state ? state[severity.key] : null;
            const token = severityColorToken(severity.key);
            const ariaLabel =
              cellCount != null
                ? `View open alerts in the ${severity.ariaSuffix} (${cellCount})`
                : `View open alerts in the ${severity.ariaSuffix}`;
            const cardInner = (
              <DashboardCard
                title={token.label}
                description={severity.description}
                className={`border-border/60 border-l-4 transition-colors hover:border-brand-500/60 hover:bg-muted/40 focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 ${token.panelRing}`}
              >
                {loading ? (
                  <Skeleton className="h-10 w-2/3" aria-hidden="true" />
                ) : cellCount != null ? (
                  <p
                    className={`font-display text-h3 leading-none tracking-tight ${token.countText}`}
                    data-testid={`dashboard-open-by-severity-count-${severity.key}`}
                  >
                    {cellCount.toLocaleString()}
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
                key={severity.key}
                href={href}
                aria-label={ariaLabel}
                className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
                data-testid={`dashboard-open-by-severity-link-${severity.key}`}
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
          className="mt-3 max-w-prose text-caption text-muted-foreground"
          data-testid="dashboard-open-by-severity-error"
        >
          Couldn’t load open alerts by severity. Stats row and recent activity are unaffected.
        </p>
      ) : null}
    </section>
  );
}
