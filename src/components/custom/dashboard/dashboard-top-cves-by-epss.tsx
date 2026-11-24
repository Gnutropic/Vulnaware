// @polsia:user-owned — "Top open CVEs by EPSS" tile for the post-login
// /dashboard. Reads GET /api/dashboard/top-cves-by-epss via apiFetch +
// the `DashboardTopCvesByEpss` schema, renders up to 8 ranked `cveId`
// rows (top CVE identifiers by `EPSS` desc across currently-open +
// hide-snoozed alerts on the caller's team), each with the EPSS %
// stamp, a severity chip, and the de-duplicated affected-asset count,
// with a deep-link to `/alerts?q=<cveId>` using the existing query-
// param convention.
//
// Visual rhythm mirrors `dashboard-top-cves.tsx` so the two rank-by-
// CVE tiles read at a glance as paired; the row framing differs in
// three respects:
//   - EPSS % stamp replaces the `n total · n critical · …` sub-line
//     (the existing tile sub-mix is not relevant on a ranking by
//     EPSS).
//   - Severity chip + asset-count are kept (mirrors the existing
//     /api/alerts chip-row posture so the rally between tile and
//     chip row stays consistent).
//   - Right-aligned EPSS % uses `tabular-nums` so vertical alignment
//     matches across rows even when one row has fewer decimals.
//
// Per-row link target: `/alerts?q=<encodeURIComponent(cveId)>` — the
// existing /alerts route already parses `q` via
// `buildAlertSearchWhere` (arm #1: `finding.cveId contains q`), so a
// click deep-links into /alerts pre-narrowed to that CVE without any
// new chip-row key.
//
// Empty-state copy: "No open CVEs with EPSS data." — distinct from
// `dashboard-top-cves.tsx`'s "No recurring CVEs in the last 7 days."
// because the predicates are different ("open" + EPSS-scored is the
// qualifier, not "recurring / 7-day windowed").

'use client';

import { Bug } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useEffect, useState } from 'react';
import { DashboardCard } from '@/components/custom/dashboard/dashboard-card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-client';
import {
  type DashboardTopCveByEpssItem as DashboardTopCveByEpssItemType,
  DashboardTopCvesByEpss as DashboardTopCvesByEpssSchema,
  type DashboardTopCvesByEpss as DashboardTopCvesByEpssType,
} from '@/lib/contracts/dashboard';

// Static skeleton row identity — fixed strings so the keys are
// stable across renders (vs an array index, which biome's
// `noArrayIndexKey` rule rejects). Eight entries mirror the
// schema's `.max(8)` cap so the loading rhythm matches the
// rendered list's bounded top-N 1:1.
const SKELETON_ROW_KEYS = [
  'top-cves-by-epss-skel-0',
  'top-cves-by-epss-skel-1',
  'top-cves-by-epss-skel-2',
  'top-cves-by-epss-skel-3',
  'top-cves-by-epss-skel-4',
  'top-cves-by-epss-skel-5',
  'top-cves-by-epss-skel-6',
  'top-cves-by-epss-skel-7',
];

// Format the raw 0..1 EPSS score to a percent string with one
// decimal. A `null` score (the joined finding had no EPSS stamp
// at ingest time) renders as "—" so the row stays aligned with
// the rest of the table instead of leaking an authoritative "0%".
function formatEpssPercent(score: number | null): string {
  if (score === null) return '—';
  const percent = Math.round(score * 1000) / 10;
  return `${percent.toFixed(1)}%`;
}

export function DashboardTopCvesByEpss(): ReactNode {
  const [data, setData] = useState<DashboardTopCvesByEpssType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    apiFetch('/api/dashboard/top-cves-by-epss', {
      schema: DashboardTopCvesByEpssSchema,
    })
      .then((envelope) => {
        if (!active) return;
        setData(envelope);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        // Soft-fail — the tile renders inert placeholders so the
        // page still works. Stats row, recent-remediations, and
        // top-assets tiles are independently fetched and
        // unaffected.
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
      data-testid="dashboard-top-cves-by-epss"
      aria-label="Top open CVEs by EPSS"
    >
      <DashboardCard
        title="Top open CVEs by EPSS"
        description="Open and reachable CVEs ranked by EPSS — click to filter."
        action={<Bug aria-hidden="true" className="size-4 text-muted-foreground" />}
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
          <p className="mt-3 text-caption text-muted-foreground">No open CVEs with EPSS data.</p>
        ) : (
          <ul className="mt-3 grid gap-2">
            {data?.items.map((item) => (
              <TopCveByEpssRow key={item.cveId} item={item} />
            ))}
          </ul>
        )}
      </DashboardCard>
      {error ? (
        <p
          role="alert"
          className="max-w-prose text-caption text-muted-foreground"
          data-testid="dashboard-top-cves-by-epss-error"
        >
          Couldn’t load top open CVEs by EPSS. Other dashboard tiles are unaffected.
        </p>
      ) : null}
    </section>
  );
}

// Single row — split out so the parent stays focused on top-level
// fetch state. Link target is `/alerts?q=<cveId>` so a click
// deep-links into the /alerts list pre-filtered to that CVE via
// the existing /alerts `q` query-param convention.
function TopCveByEpssRow({ item }: { item: DashboardTopCveByEpssItemType }): ReactNode {
  const href = `/alerts?q=${encodeURIComponent(item.cveId)}`;
  const ariaLabel = `View alerts for ${item.cveId} (EPSS ${formatEpssPercent(item.epssScore)})`;

  return (
    <li>
      <Link
        href={href}
        aria-label={ariaLabel}
        data-testid={`dashboard-top-cves-by-epss-row-${item.cveId}`}
        className="flex items-center justify-between gap-3 rounded-md border border-transparent px-2 py-1.5 transition-colors hover:border-brand-500/40 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-caption text-foreground">{item.cveId}</span>
          {item.dominantSeverity ? (
            <Badge
              variant={severityVariant(item.dominantSeverity)}
              className="font-mono uppercase tracking-wider"
            >
              {item.dominantSeverity}
            </Badge>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-3">
          <span className="font-display text-h4 leading-none tracking-tight text-foreground tabular-nums">
            {formatEpssPercent(item.epssScore)}
          </span>
          <span className="font-display text-h4 leading-none tracking-tight text-muted-foreground tabular-nums">
            {item.affectedAssetCount.toLocaleString()}
          </span>
        </span>
      </Link>
    </li>
  );
}

// Map a free-form severity literal to a Badge variant. `critical |
// high` collapse to `destructive`, `medium` → `secondary`, anything
// else (incl. `low` and `null`) → `outline`. Verbatim copy of the
// helper at `dashboard-top-cves.tsx` — defined locally so this
// component never cross-imports the parallel top-cves tile.
function severityVariant(
  sev: 'critical' | 'high' | 'medium' | 'low' | null | undefined,
): 'destructive' | 'secondary' | 'outline' {
  const s = (sev ?? '').toLowerCase();
  if (s === 'critical' || s === 'high') return 'destructive';
  if (s === 'medium') return 'secondary';
  return 'outline';
}
