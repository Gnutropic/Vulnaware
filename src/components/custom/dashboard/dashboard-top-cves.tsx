// @polsia:user-owned — "Top recurring CVEs" tile for the post-login
// /dashboard. Reads GET /api/dashboard/top-cves via apiFetch + the
// `DashboardTopCves` schema, renders up to 5 ranked `cveId` rows
// (top CVE identifiers by total occurrence across open AND
// recently-remediated last-7d alerts on the caller's team), each
// with a severity-mix sub-line and a deep-link to
// `/alerts?q=<cveId>` using the existing query-param convention.
//
// Visual rhythm mirrors `dashboard-recent-remediations.tsx` +
// `dashboard-top-assets.tsx` (the two existing top-N list tiles):
//   - Tile title + description (click-to-open framing) preserved.
//   - 5 static-key `<Skeleton>` rows during loading so the card
//     never flashes an authoritative "0" mid-fetch.
//   - Error: muted "—" placeholder + trailing `<p role="alert">`
//     so the surrounding islands are untouched.
//   - Empty: single muted line "No recurring CVEs in the last 7
//     days." when `items.length === 0` (a team with zero
//     contributing alerts).
//   - Success: per-row link with cveId (mono caption), dominant
//     severity pill, sub-mix "n critical · n high · …" (zero
//     tiers omitted), and a total count stamp.
//
// Per-row link target is `/alerts?q=<encodeURIComponent(cveId)>` —
// the existing /alerts route already parses `q` via
// `buildAlertSearchWhere` (arm #1: `finding.cveId contains q`),
// so a click on a row lands on /alerts pre-narrowed to that CVE
// without any new chip-row key.

'use client';

import { Bug } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useEffect, useState } from 'react';
import { DashboardCard } from '@/components/custom/dashboard/dashboard-card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-client';
import {
  type DashboardTopCveItem as DashboardTopCveItemType,
  DashboardTopCves as DashboardTopCvesSchema,
  type DashboardTopCves as DashboardTopCvesType,
} from '@/lib/contracts/dashboard';

// Static skeleton row identity — fixed strings so the keys are
// stable across renders (vs an array index, which biome's
// `noArrayIndexKey` rule rejects). Five entries mirror the
// rendered list's top-N cap so the loading rhythm matches the
// card body 1:1.
const SKELETON_ROW_KEYS = [
  'top-cves-skel-0',
  'top-cves-skel-1',
  'top-cves-skel-2',
  'top-cves-skel-3',
  'top-cves-skel-4',
];

// Wire-order for the four sub-mix tiers. Critical/High collapse to
// `destructive` and Medium to `secondary` in the summary chip;
// tier order at render mirrors the chip-row emitter at
// `src/lib/business/alerts-severity.ts` so the visible sub-mix
// reads in the same ladder order as the active severity chip on
// /alerts.
const SUB_MIX_ORDER: Array<'critical' | 'high' | 'medium' | 'low'> = [
  'critical',
  'high',
  'medium',
  'low',
];

// Compose the per-CVE sub-mix string ("n critical · n high · …")
// from the four-tier mix. Zero entries are omitted so the visible
// string stays compact; matches the tier-by-tier rendering at
// `dashboard-open-by-severity.tsx`.
function formatSubMix(mix: DashboardTopCveItemType['mix']): string {
  const parts: string[] = [];
  for (const tier of SUB_MIX_ORDER) {
    const n = mix[tier];
    if (n > 0) parts.push(`${n.toLocaleString()} ${tier}`);
  }
  return parts.length > 0 ? parts.join(' · ') : '—';
}

export function DashboardTopCves(): ReactNode {
  const [data, setData] = useState<DashboardTopCvesType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    apiFetch('/api/dashboard/top-cves', { schema: DashboardTopCvesSchema })
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
      data-testid="dashboard-top-cves"
      aria-label="Top recurring CVEs"
    >
      <DashboardCard
        title="Top recurring CVEs"
        description="Open and recently-remediated alerts grouped by CVE — click to filter."
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
          <p className="mt-3 text-caption text-muted-foreground">
            No recurring CVEs in the last 7 days.
          </p>
        ) : (
          <ul className="mt-3 grid gap-2">
            {data?.items.map((item) => (
              <TopCveRow key={item.cveId} item={item} />
            ))}
          </ul>
        )}
      </DashboardCard>
      {error ? (
        <p
          role="alert"
          className="max-w-prose text-caption text-muted-foreground"
          data-testid="dashboard-top-cves-error"
        >
          Couldn’t load top recurring CVEs. Other dashboard tiles are unaffected.
        </p>
      ) : null}
    </section>
  );
}

// Single row — split out so the parent stays focused on top-level
// fetch state. Link target is `/alerts?q=<cveId>` so a click
// deep-links into the /alerts list pre-filtered to that CVE via
// the existing /alerts `q` query-param convention.
function TopCveRow({ item }: { item: DashboardTopCveItemType }): ReactNode {
  const href = `/alerts?q=${encodeURIComponent(item.cveId)}`;
  const ariaLabel = `View alerts for ${item.cveId} (${item.count})`;

  return (
    <li>
      <Link
        href={href}
        aria-label={ariaLabel}
        data-testid={`dashboard-top-cves-row-${item.cveId}`}
        className="flex items-center justify-between gap-3 rounded-md border border-transparent px-2 py-1.5 transition-colors hover:border-brand-500/40 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-caption text-foreground">{item.cveId}</span>
          <span className="truncate text-caption text-muted-foreground">
            {formatSubMix(item.mix)}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {item.dominantSeverity ? (
            <Badge
              variant={severityVariant(item.dominantSeverity)}
              className="font-mono uppercase tracking-wider"
            >
              {item.dominantSeverity}
            </Badge>
          ) : null}
          <span className="font-display text-h4 leading-none tracking-tight text-foreground tabular-nums">
            {item.count.toLocaleString()}
          </span>
        </span>
      </Link>
    </li>
  );
}

// Map a free-form severity literal to a Badge variant. `critical |
// high` collapse to `destructive`, `medium` → `secondary`, anything
// else (incl. `low` and `null`) → `outline`. Verbatim copy of the
// helper at `dashboard-top-assets.tsx:58-65` — defined locally so
// this component never cross-imports the top-assets tile.
function severityVariant(
  sev: 'critical' | 'high' | 'medium' | 'low' | null | undefined,
): 'destructive' | 'secondary' | 'outline' {
  const s = (sev ?? '').toLowerCase();
  if (s === 'critical' || s === 'high') return 'destructive';
  if (s === 'medium') return 'secondary';
  return 'outline';
}
