// @polsia:user-owned — Asset detail client island for the /assets/[host]
// drill-down page. Surfaces a per-host header card (asset type, first /
// last seen, Open / Remediated / Snoozed count tiles, severity
// breakdown chips, dominant severity badge) PLUS a fully-filtered
// alerts list with the SAME filter affordances as /alerts (multi-
// select severity chips, status / source / since / date-range chip
// rows, text query input, sort dropdown, count badges, hover-snooze
// outline, four boolean-flag chip rows for Owned-by-me / Remediated-
// only / Snoozed-only / Open-only with the page-level mutex).
//
// Two parallel fetches:
//   - `loadAssetDetailData` reads GET /api/assets/<host> for the
//     header card (host envelope: `AssetDetail` schema). Triggered
//     once per `host` change (the host is a path-param, so the fetch
//     is mount-keyed).
//   - `loadAlertsData` reads GET /api/assets/<host>/alerts for the
//     alert list (mirror of /api/alerts with a host narrowing
//     clause). Re-fires on every `effectiveQs` change.
//
// The chip-rows + sort dropdown + text query + date range + count
// badges are all imported from `src/components/dashboard/*` (the
// same primitives /alerts uses); the URL writer is the existing
// `buildEffectiveQs` from `@/lib/business/alerts-effective-qs` so a
// permalink from /alerts?q=foo drops the same `/alerts` chip state
// into the per-host drill-down AND vice versa. The host param is a
// PATH SEGMENT here rather than a `q=` substring — the chip row
// stays unchanged and reads from the URL's query string.
//
// All data flows through apiFetch — no Prisma / server-only imports
// — and the page above (Server Component) does the SessionUser
// redirect + the generateMetadata call. The /api endpoints are
// member-gated via `requireTeamRole('member')` so an unauthorized
// caller gets a 401 / 403 rather than silently leaking another
// team's host data.

'use client';

import { ArrowLeft, Loader2, ScanLine, Server } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AlertsCountBadges } from '@/components/dashboard/alerts-count-badges';
import {
  AlertsDateRangeChipRow,
  type DateRangePreset,
} from '@/components/dashboard/alerts-date-range-chip-row';
import { AlertsDateRangeInput } from '@/components/dashboard/alerts-date-range-input';
import { AlertsFalsePositiveDialog } from '@/components/dashboard/alerts-false-positive-dialog';
import { AlertsListCards } from '@/components/dashboard/alerts-list-cards';
import { AlertsOpenChipRow, type OpenOnlyFlag } from '@/components/dashboard/alerts-open-chip-row';
import {
  AlertsOwnerChipRow,
  type OwnedByMeFlag,
} from '@/components/dashboard/alerts-owner-chip-row';
import {
  AlertsRemediatedChipRow,
  type RemediatedOnlyFlag,
} from '@/components/dashboard/alerts-remediated-chip-row';
import { AlertsReopenDialog } from '@/components/dashboard/alerts-reopen-dialog';
import { AlertsSearchQueryBadge } from '@/components/dashboard/alerts-search-query-badge';
import { AlertsSeverityChipRow } from '@/components/dashboard/alerts-severity-chip-row';
import { AlertsSinceChipRow } from '@/components/dashboard/alerts-since-chip-row';
import {
  AlertsSnoozedChipRow,
  type SnoozedOnlyFlag,
} from '@/components/dashboard/alerts-snoozed-chip-row';
import { AlertsSortSelect } from '@/components/dashboard/alerts-sort-select';
import {
  AlertsSourceChipRow,
  type SourceFilter,
} from '@/components/dashboard/alerts-source-chip-row';
import {
  AlertsStatusChipRow,
  type StatusFilter,
} from '@/components/dashboard/alerts-status-chip-row';
import { AlertsTextQueryInput } from '@/components/dashboard/alerts-text-query-input';
import { AssetRemediationTimeline } from '@/components/dashboard/asset-remediation-timeline';
import { AssetRiskTrendSparkline } from '@/components/dashboard/asset-risk-trend-sparkline';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-client';
import { buildEffectiveQs } from '@/lib/business/alerts-effective-qs';
import { parseSeverityFilter, type SeverityLiteral } from '@/lib/business/alerts-severity';
import type { SinceFilter } from '@/lib/business/alerts-since';
import {
  AlertFalsePositiveResponse,
  AlertList,
  AlertQuery,
  AlertResolveResponse,
  type AlertSortKey,
} from '@/lib/contracts/alerts';
import { type AssetDetail, AssetDetail as AssetDetailSchema } from '@/lib/contracts/assets-detail';

function severityVariant(sev: string | null | undefined): 'destructive' | 'secondary' | 'outline' {
  const s = (sev ?? '').toLowerCase();
  if (s === 'critical' || s === 'high') return 'destructive';
  if (s === 'medium') return 'secondary';
  return 'outline';
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function scanStatusVariant(
  status: NonNullable<AssetDetail['latestScanStatus']>,
): 'default' | 'destructive' | 'secondary' | 'outline' {
  if (status === 'completed') return 'default';
  if (status === 'failed') return 'destructive';
  if (status === 'running') return 'secondary';
  return 'outline';
}

function scanStatusLabel(status: AssetDetail['recentScans'][number]['status']): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

// `—` placeholder for zero-valued count tiles so the layout never
// collapses on a brand-new host. The number tiles are stamped
// `tabular-nums` so they don't reflow on changing digit widths.
const ZERO_PLACEHOLDER = '—';

// Stable skeleton-key map. Fixed strings so biome's `noArrayIndexKey`
// rule is satisfied — the loading-state has no real row data to
// keyBy. The detail card stays identical to the loaded card so the
// on-screen handoff has no jump.
const SKELETON_KEYS = ['sk-c-0', 'sk-c-1', 'sk-c-2', 'sk-c-3'];

interface AssetDetailClientProps {
  host: string;
}

export function AssetDetailClient({ host }: AssetDetailClientProps) {
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [alertsData, setAlertsData] = useState<AlertList | null>(null);
  // `error` mirrors the /alerts/[id] page's three-state posture:
  // - null + detail === null  → loading
  // - 'not_found'             → 404 stub
  // - any other string        → generic error
  // - detail !== null         → loaded (header card populated)
  const [error, setError] = useState<string | null>(null);

  // Host-envelope fetch — once per `host` change. The host is the
  // route's path segment so a navigation between two /assets/<host>
  // pages re-fires; the chip-rows below trigger
  // `loadAlertsData` re-fetches without re-firing this one (the
  // header card's envelope reflects the contributing-alert universe,
  // not the chip-filtered slice).
  useEffect(() => {
    let active = true;
    setDetail(null);
    setError(null);
    apiFetch(`/api/assets/${encodeURIComponent(host)}`, { schema: AssetDetailSchema })
      .then((payload) => {
        if (active) setDetail(payload);
      })
      .catch((err: unknown) => {
        if (!active) return;
        const status =
          err && typeof err === 'object' && 'cause' in err
            ? (() => {
                const c = (err as { cause?: unknown }).cause;
                if (c && typeof c === 'object' && 'status' in c) {
                  return (c as { status?: number }).status;
                }
                return undefined;
              })()
            : undefined;
        const msg = err instanceof Error ? err.message : 'Unknown error';
        if (status === 404) {
          setError('not_found');
        } else {
          setError(msg);
        }
      });
    return () => {
      active = false;
    };
  }, [host]);

  if (error === 'not_found') {
    return (
      <div className="flex flex-col gap-6">
        <div className="sticky top-14 z-30 -mx-gutter bg-background/95 px-gutter py-2 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <Button asChild variant="ghost" size="sm" className="-ml-2 min-h-11 w-fit md:min-h-0">
            <Link href="/assets">
              <ArrowLeft className="size-4" aria-hidden /> Back to assets
            </Link>
          </Button>
        </div>
        <Card className="border-border/80 bg-card shadow-sm">
          <CardHeader className="space-y-2">
            <CardDescription className="text-eyebrow uppercase tracking-wider text-muted-foreground">
              Asset
            </CardDescription>
            <CardTitle className="font-mono text-h3 tracking-tight text-foreground">
              {host}
            </CardTitle>
            <CardDescription className="text-body text-muted-foreground">
              We don’t have any alerts for this host in your team. It may have been removed, or the
              scanner hasn’t picked it up yet.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/assets">
                <ArrowLeft className="size-4" aria-hidden /> Back to assets
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex flex-col gap-6">
        <div className="sticky top-14 z-30 -mx-gutter bg-background/95 px-gutter py-2 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <Button asChild variant="ghost" size="sm" className="-ml-2 min-h-11 w-fit md:min-h-0">
            <Link href="/assets">
              <ArrowLeft className="size-4" aria-hidden /> Back to assets
            </Link>
          </Button>
        </div>
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-destructive">Couldn’t load this asset</CardTitle>
            <CardDescription>
              Try returning to the assets list and reopening the detail.
            </CardDescription>
            <CardDescription className="font-mono text-caption text-muted-foreground">
              {error}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/assets">
                <ArrowLeft className="size-4" aria-hidden /> Back to assets
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }
  if (!detail) {
    return <AssetDetailSkeleton />;
  }
  return (
    <AssetDetailLoaded
      host={host}
      detail={detail}
      alertsData={alertsData}
      setAlertsData={setAlertsData}
    />
  );
}

// Loaded-state partition. Split from the parent so the parent's
// guard-return skeleton (which is a NON-ReactElement conditional) is
// visually distinct from the loaded-state body, AND so the chip-row
// state + `useSearchParams` reactivity only mount once we KNOW we
// have a populated `detail` envelope (avoids a chip-state flicker
// when the host-envelope fetch returns after first paint).
function AssetDetailLoaded({
  host,
  detail,
  alertsData,
  setAlertsData,
}: {
  host: string;
  detail: AssetDetail;
  alertsData: AlertList | null;
  setAlertsData: React.Dispatch<React.SetStateAction<AlertList | null>>;
}) {
  const router = useRouter();
  const initialSearchParams = useSearchParams();

  // Suspense boundary at page level (below) ensures `useSearchParams`
  // is safe to read here.
  const initialParsed = useMemo(
    () => parseFiltersFromParams(initialSearchParams),
    [initialSearchParams],
  );

  // Filter-state mirrors /alerts/page.tsx:200-220 exactly so a
  // permalink with `?severity=critical&q=foo` lands on the chip row
  // with the same active set the /alerts page would. Each chip row
  // owns its setter — toggling fires `router.replace(/assets/<host>?...)`
  // via the `effectiveQs` useMemo below, and the fetch effect below
  // re-fires GET /api/assets/<host>/alerts when the URL changes.
  const [severity, setSeverity] = useState<Set<SeverityLiteral> | null>(
    () => initialParsed.severity,
  );
  const [status, setStatus] = useState<StatusFilter>(() => initialParsed.status);
  const [triggeredBy, setTriggeredBy] = useState<SourceFilter>(() => initialParsed.triggeredBy);
  const [hideSnoozed, setHideSnoozed] = useState<boolean>(() => initialParsed.hideSnoozed);
  const [ownedByMe, setOwnedByMe] = useState<OwnedByMeFlag>(() => initialParsed.ownedByMe);
  const [remediatedOnly, setRemediatedOnly] = useState<RemediatedOnlyFlag>(
    () => initialParsed.remediatedOnly,
  );
  // Snoozed and Open both compose alongside the other two boolean-
  // flag chips rather than mutex-clearing; the writers below handle
  // the wire-emit shape. Open is the only one with a wire-key
  // collision to manage (`?status=open`) — `parseFiltersFromParams`
  // strips `status` from its zod parse when `openOnly` is true so
  // the enum chip writer never ALSO emits the same literal.
  const [snoozedOnly, setSnoozedOnly] = useState<SnoozedOnlyFlag>(() => initialParsed.snoozedOnly);
  const [openOnly, setOpenOnly] = useState<OpenOnlyFlag>(() => initialParsed.openOnly);
  const [since, setSince] = useState<SinceFilter>(() => initialParsed.since);
  const [sort, setSort] = useState<AlertSortKey>(() => initialParsed.sort);
  // Free-form text query — lazy init reads `?q=…` on first mount so a
  // permalink from anywhere lands the badge already-active with the
  // same value the input island owns. The input island is the ONLY
  // writer (debounced 250ms keystroke) and pushes router.replace
  // after each idle tick. This state has no setter because the page
  // never mutates q itself; "lazily initialized on first mount" is
  // the only role of this read.
  const q = useMemo<string | null>(() => initialParsed.q, [initialParsed.q]);

  const [unresolvedAlerts, setUnresolvedAlerts] = useState<AlertList | null>(null);
  const [unresolvedAlertsLoading, setUnresolvedAlertsLoading] = useState(true);
  const [unresolvedAlertsError, setUnresolvedAlertsError] = useState<string | null>(null);

  // Date-range preset chip + the `<input type="date">` pair live as a
  // single `<AlertsDateRangeChipRow>` + `<AlertsDateRangeInput>`
  // composition. Mirror /alerts/page.tsx:622-636 so a permalink
  // `?from=YYYY-MM-DD&to=YYYY-MM-DD` lands already-active and a chip
  // click writes the same key shape the dates-on-mount would.
  const dateRangePreset = useMemo<DateRangePreset>(
    () => initialParsed.dateRangePreset,
    [initialParsed.dateRangePreset],
  );

  // Base path the URL writers target. Two URL writers exist on this
  // page (`buildEffectiveQs` for chip-rows + the alert-list fetch,
  // and `AlertsTextQueryInput` / `AlertsDateRangeInput` for the
  // keyboard-driven inputs). Every writer emits to the same
  // `/assets/<host>` path so the chip strip and the input strip stay
  // in lockstep on a single router.replace target.
  const basePath = `/assets/${encodeURIComponent(host)}`;

  const handleDateRangePresetChange = useCallback(
    (next: DateRangePreset) => {
      const params = new URLSearchParams(initialSearchParams.toString());
      if (next === null) {
        params.delete('from');
        params.delete('to');
      } else {
        const days = next === '7d' ? 7 : next === '30d' ? 30 : 90;
        params.set('from', new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10));
        params.set('to', new Date().toISOString().slice(0, 10));
      }
      const qs = params.toString();
      router.replace(`${basePath}${qs ? `?${qs}` : ''}`, { scroll: false });
    },
    [initialSearchParams, router, basePath],
  );

  // URL writer — compose the chip-state + current URL's `q` / `from` /
  // `to` keys (the input islands own `q` / `from` / `to`) into the
  // canonical query string the alert-list route + the /api fetch
  // both read. Mirrors /alerts/page.tsx:636-670 verbatim with
  // `basePath` swapped to the per-host destination.
  const effectiveQs = useMemo(
    () =>
      buildEffectiveQs(
        {
          severity,
          status,
          triggeredBy,
          hideSnoozed,
          highRiskAssets: false,
          ownedByMe,
          remediatedOnly,
          snoozedOnly,
          openOnly,
          // The /assets detail page does NOT ship a "Resolved
          // only" boolean-flag chip (the chip is exclusive to
          // /alerts for v1). Default `false` so the writer reads
          // it as the resting state and never emits
          // `?status=resolved` from this surface — a permalink
          // that originated on /alerts with `?status=resolved`
          // would not have arrived here, but the explicit
          // `false` guards against future drift in the
          // chip-set surface.
          resolvedOnly: false,
          sort,
          since,
          // The /assets detail page doesn't ship an asset-multi-
          // select chip (the host is in the path). Pass `null`
          // explicitly so the URL never picks up a stale
          // `?asset=…` from a permalink that originated on /alerts.
          asset: null,
        },
        initialSearchParams,
        // Empty selection on this page — bulk actions stay out of
        // v1 scope per the brief (per-row Reopen / FP only).
        new Set<string>(),
      ),
    [
      severity,
      status,
      triggeredBy,
      hideSnoozed,
      ownedByMe,
      remediatedOnly,
      snoozedOnly,
      openOnly,
      sort,
      since,
      initialSearchParams,
    ],
  );

  // Mirror URL on every chip change. `router.replace` so the back
  // button leaves the asset-detail page rather than stepping
  // through every chip click. The input writers (text + date) own
  // the URL roundtrip for keystrokes; this effect owns the chip
  // roundtrip.
  useEffect(() => {
    router.replace(`${basePath}${effectiveQs}`, { scroll: false });
  }, [effectiveQs, router, basePath]);

  // Re-fetch the alerts list whenever `effectiveQs` changes. The
  // host-envelope fetch above is mount-keyed; this list fetch
  // responds to the chip-row URL writer. Mirrors
  // /alerts/page.tsx:683-698 shape verbatim so a chip click on
  // either surface lands on the same effective query.
  useEffect(() => {
    let active = true;
    apiFetch(`/api/assets/${encodeURIComponent(host)}/alerts${effectiveQs}`, { schema: AlertList })
      .then((payload) => {
        if (active) setAlertsData(payload);
      })
      .catch((err: unknown) => {
        if (!active) return;
        const msg = err instanceof Error ? err.message : 'Unknown error';
        // We DON'T toast on every chip-click 500 — a transient
        // refresh on a filter sweep is non-fatal, but a
        // fully-loaded failure should still surface so the
        // operator knows. Mirror /alerts/page.tsx:689-694.
        // Land here only on real backend errors (network / 500)
        // since 4xx leakage is contract-validated upstream.
        toast.error('Could not load alerts for this host.');
        setAlertsData(null);
        void msg;
      });
    return () => {
      active = false;
    };
  }, [host, effectiveQs, setAlertsData]);

  // Keep the focused unresolved read independent from the URL-driven triage
  // table. It resets on host changes and uses the same scoped endpoint, so a
  // filter click never makes the summary card appear empty or stale.
  useEffect(() => {
    let active = true;
    setUnresolvedAlerts(null);
    setUnresolvedAlertsError(null);
    setUnresolvedAlertsLoading(true);
    apiFetch(`/api/assets/${encodeURIComponent(host)}/alerts?unresolved=1&pageSize=200`, {
      schema: AlertList,
    })
      .then((payload) => {
        if (!active) return;
        setUnresolvedAlerts(payload);
        setUnresolvedAlertsLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setUnresolvedAlertsError(
          err instanceof Error ? err.message : 'Could not load unresolved alerts.',
        );
        setUnresolvedAlertsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [host]);

  // Per-row "Reopen" handler — small POST + optimistic flip. Mirror
  // of /alerts/page.tsx:741-782 with the path rewritten to the
  // global `/api/alerts/<id>/reopen` route (the same route /alerts
  // uses, so a row toggle on either surface lands on the same
  // server-authoritative state).
  const [reopenPendingId, setReopenPendingId] = useState<string | null>(null);
  const handleReopen = useCallback(
    async (id: string) => {
      if (!alertsData || reopenPendingId) return;
      const row = alertsData.items.find((r) => r.id === id);
      if (!row || row.status !== 'resolved') return;
      setReopenPendingId(id);
      try {
        const res = await fetch(`/api/alerts/${id}/reopen`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
          cache: 'no-store',
        });
        if (!res.ok) {
          try {
            await res.json();
          } catch {
            // ignore — drain only.
          }
          toast.error('Could not reopen alert.');
          return;
        }
        const parsed = AlertResolveResponse.safeParse(await res.json());
        if (!parsed.success || parsed.data.status !== 'open') {
          toast.error('Could not reopen alert.');
          return;
        }
        setAlertsData({
          ...alertsData,
          items: alertsData.items.map((item) =>
            item.id === id ? { ...item, status: 'open' as const } : item,
          ),
        });
        toast.success('Alert reopened.');
      } catch {
        toast.error('Could not reopen alert.');
      } finally {
        setReopenPendingId(null);
      }
    },
    [alertsData, reopenPendingId, setAlertsData],
  );

  // Per-row "Mark false positive" handler — opens the same
  // shared dialog the /alerts row uses, posts to the global
  // /api/alerts/<id>/false-positive route, optimistic-flips on
  // success. The dialog is PRESENTATIONAL — the page owns the open
  // state + the post + the flip.
  const [fpDialogOpen, setFpDialogOpen] = useState(false);
  const [fpDialogTarget, setFpDialogTarget] = useState<string | null>(null);
  const [fpSubmitting, setFpSubmitting] = useState(false);
  const [fpSubmittingFor, setFpSubmittingFor] = useState<string | null>(null);

  const openFalsePositiveDialogSingle = useCallback((id: string) => {
    setFpDialogTarget(`per-row:${id}`);
    setFpDialogOpen(true);
  }, []);

  const submitSingleFalsePositive = useCallback(
    async (id: string, reason: string) => {
      if (!alertsData || fpSubmitting) return;
      setFpSubmitting(true);
      setFpSubmittingFor(id);
      try {
        const res = await fetch(`/api/alerts/${id}/false-positive`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason }),
          cache: 'no-store',
        });
        if (!res.ok) {
          try {
            await res.json();
          } catch {
            // ignore — drain only.
          }
          toast.error('Could not mark alert as false positive.');
          return;
        }
        const parsed = AlertFalsePositiveResponse.safeParse(await res.json());
        if (!parsed.success || parsed.data.status !== 'false_positive') {
          toast.error('Could not mark alert as false positive.');
          return;
        }
        const stampedReason = parsed.data.falsePositiveReason ?? reason;
        setAlertsData({
          ...alertsData,
          items: alertsData.items.map((item) =>
            item.id === id
              ? {
                  ...item,
                  status: 'false_positive' as const,
                  falsePositiveReason: stampedReason,
                }
              : item,
          ),
        });
        toast.success('Alert marked as false positive.');
      } catch {
        toast.error('Could not mark alert as false positive.');
      } finally {
        setFpSubmitting(false);
        setFpSubmittingFor(null);
      }
    },
    [alertsData, fpSubmitting, setAlertsData],
  );

  const handleFalsePositiveSubmit = useCallback(
    async (reason: string) => {
      if (!fpDialogTarget) return;
      if (fpDialogTarget.startsWith('per-row:')) {
        const id = fpDialogTarget.slice('per-row:'.length);
        await submitSingleFalsePositive(id, reason);
        setFpDialogOpen(false);
      }
    },
    [fpDialogTarget, submitSingleFalsePositive],
  );

  const fpDialogTargetLabel = useMemo(() => {
    if (fpDialogTarget == null) return '';
    if (fpDialogTarget.startsWith('per-row:')) {
      return fpDialogTarget.slice('per-row:'.length).trim() || 'this alert';
    }
    return 'this alert';
  }, [fpDialogTarget]);

  return (
    <div className="flex flex-col gap-6">
      <div className="sticky top-14 z-30 -mx-gutter bg-background/95 px-gutter py-2 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <Button asChild variant="ghost" size="sm" className="-ml-2 min-h-11 w-fit md:min-h-0">
          <Link href="/assets">
            <ArrowLeft className="size-4" aria-hidden /> Back to assets
          </Link>
        </Button>
      </div>

      <Card className="border-border/80 bg-card shadow-sm">
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-2">
              <CardDescription className="text-eyebrow uppercase tracking-wider text-muted-foreground">
                Asset
              </CardDescription>
              <CardTitle className="font-display text-h2 tracking-tight text-foreground">
                <span className="inline-flex items-center gap-2">
                  <Server className="size-5 text-brand-500" aria-hidden />
                  <span className="font-mono text-h2 tracking-tight">{detail.host}</span>
                </span>
              </CardTitle>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {/* Asset-type chip — derived on the server via the same
                  `inferAssetType + pickDominantAssetType` ladder the
                  /assets rollup uses. Mirrors the AssetRollupRow's
                  `assetType` column byte-for-byte so the detail page
                  and the rollup read as the same surface. */}
              <Badge
                variant="outline"
                className="font-mono text-caption uppercase tracking-wider"
                aria-label={`Asset type ${detail.assetType}`}
              >
                Type {detail.assetType}
              </Badge>
              {detail.dominantSeverity ? (
                <Badge
                  variant={severityVariant(detail.dominantSeverity)}
                  className="font-mono uppercase tracking-wider"
                >
                  {detail.dominantSeverity}
                </Badge>
              ) : null}
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <div className="flex flex-col gap-1">
              <dt className="text-eyebrow uppercase tracking-wider text-muted-foreground">
                First seen
              </dt>
              <dd className="text-body text-foreground">{formatTimestamp(detail.firstSeen)}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-eyebrow uppercase tracking-wider text-muted-foreground">
                Last seen
              </dt>
              <dd className="text-body text-foreground">{formatTimestamp(detail.lastSeen)}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-eyebrow uppercase tracking-wider text-muted-foreground">
                Open alerts
              </dt>
              <dd className="font-display text-h4 leading-none tracking-tight text-foreground tabular-nums">
                {(detail.openCount || ZERO_PLACEHOLDER).toLocaleString()}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-eyebrow uppercase tracking-wider text-muted-foreground">
                Unresolved alerts
              </dt>
              <dd className="font-display text-h4 leading-none tracking-tight text-foreground tabular-nums">
                {detail.unresolvedCount.toLocaleString()}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-eyebrow uppercase tracking-wider text-muted-foreground">
                Remediated
              </dt>
              <dd className="font-display text-h4 leading-none tracking-tight text-brand-600 tabular-nums">
                {detail.remediatedCount.toLocaleString()}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-eyebrow uppercase tracking-wider text-muted-foreground">
                Snoozed
              </dt>
              <dd className="font-display text-h4 leading-none tracking-tight text-foreground tabular-nums">
                {detail.snoozedCount.toLocaleString()}
              </dd>
            </div>
          </dl>
          <div className="flex flex-col gap-2" aria-live="polite">
            <span className="text-eyebrow uppercase tracking-wider text-muted-foreground">
              Unresolved severity
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              {(['critical', 'high', 'medium', 'low'] as const).map((sev) => (
                <Badge
                  key={sev}
                  variant={severityVariant(sev)}
                  className="font-mono text-caption uppercase tracking-wider"
                >
                  {sev} {detail.severityCounts[sev].toLocaleString()}
                </Badge>
              ))}
            </div>
            {detail.unresolvedCount === 0 && (
              <div className="rounded-md border border-dashed border-border/80 bg-muted/30 px-3 py-2 text-body font-medium text-muted-foreground">
                No unresolved alerts
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <section aria-labelledby="asset-scan-freshness-heading">
        <Card className="border-border/80 bg-card shadow-sm">
          <CardHeader className="flex flex-row items-center gap-2 space-y-0 pb-3">
            <ScanLine className="size-4 text-brand-500" aria-hidden />
            <CardTitle
              id="asset-scan-freshness-heading"
              className="font-display text-body tracking-tight text-foreground"
            >
              Scan freshness
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-eyebrow uppercase tracking-wider text-muted-foreground">
                  Latest scan
                </span>
                {detail.latestScanAt ? (
                  <time dateTime={detail.latestScanAt} className="text-body text-foreground">
                    {formatTimestamp(detail.latestScanAt)}
                  </time>
                ) : (
                  <span className="text-body text-muted-foreground">
                    No scans recorded for this asset.
                  </span>
                )}
              </div>
              {detail.latestScanStatus ? (
                <Badge
                  variant={scanStatusVariant(detail.latestScanStatus)}
                  className="font-mono text-caption uppercase tracking-wider"
                >
                  {detail.latestScanStatus}
                </Badge>
              ) : null}
            </div>

            <div className="flex flex-col gap-2" aria-live="polite">
              <span className="text-eyebrow uppercase tracking-wider text-muted-foreground">
                Recent scan outcomes
              </span>
              {detail.recentScans.length === 0 ? (
                <p className="rounded-md border border-dashed border-border/80 bg-muted/30 px-3 py-2 text-body text-muted-foreground">
                  No scan history is available for this asset.
                </p>
              ) : (
                <ul className="flex flex-col divide-y divide-border/70 rounded-md border border-border/70">
                  {detail.recentScans.map((scan) => {
                    const outcomeAt = scan.finishedAt ?? scan.startedAt;
                    return (
                      <li
                        key={scan.id}
                        className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                      >
                        <Badge
                          variant={scanStatusVariant(scan.status)}
                          className="font-mono text-caption uppercase tracking-wider"
                        >
                          {scanStatusLabel(scan.status)}
                        </Badge>
                        <time dateTime={outcomeAt} className="text-caption text-muted-foreground">
                          {formatTimestamp(outcomeAt)}
                        </time>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>
      </section>

      <UnresolvedAlertsCard
        data={unresolvedAlerts}
        error={unresolvedAlertsError}
        loading={unresolvedAlertsLoading}
      />

      <section aria-labelledby="asset-alerts-heading" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2
            id="asset-alerts-heading"
            className="font-display text-h3 tracking-tight text-foreground"
          >
            Alerts on this host
          </h2>
          <p className="text-body text-muted-foreground">
            Every alert currently associated with <span className="font-mono">{detail.host}</span> —
            same filter affordances as the team-wide{' '}
            <Link href="/alerts" className="text-brand-500 underline-offset-2 hover:underline">
              /alerts
            </Link>{' '}
            view.
          </p>
        </div>

        {/* Chip-rows band — imports the SAME primitives /alerts uses so the
            detail page and the alerts page read as one filter band. The
            URL writers all target `/assets/<host>` via `effectiveQs` so a
            permalink round-trips byte-for-byte. */}
        <AlertsSeverityChipRow
          value={severity}
          onChange={setSeverity}
          options={alertsData?.severityOptions ?? []}
        />
        <AlertsStatusChipRow value={status} onChange={setStatus} />
        <AlertsSourceChipRow value={triggeredBy} onChange={setTriggeredBy} />
        <AlertsSinceChipRow value={since} onChange={setSince} />
        <AlertsDateRangeChipRow value={dateRangePreset} onChange={handleDateRangePresetChange} />
        <fieldset
          aria-label="Snooze visibility"
          className="flex flex-wrap items-center gap-2 border-0 p-0 m-0"
        >
          <Button
            type="button"
            size="sm"
            variant={hideSnoozed ? 'default' : 'outline'}
            aria-pressed={hideSnoozed}
            data-active={hideSnoozed}
            onClick={() => setHideSnoozed((prev) => !prev)}
            className="min-h-11 rounded-full px-4 md:min-h-0 md:px-3"
          >
            Hide snoozed
          </Button>
        </fieldset>
        <AlertsOwnerChipRow
          value={ownedByMe}
          onChange={(next) => {
            if (!next) {
              setOwnedByMe(false);
              return;
            }
            setOwnedByMe(true);
            setRemediatedOnly(false);
            setSnoozedOnly(false);
            setOpenOnly(false);
          }}
        />
        <AlertsRemediatedChipRow
          value={remediatedOnly}
          onChange={(next) => {
            if (!next) {
              setRemediatedOnly(false);
              return;
            }
            setRemediatedOnly(true);
            setOwnedByMe(false);
            setSnoozedOnly(false);
            setOpenOnly(false);
          }}
        />
        <AlertsSnoozedChipRow
          value={snoozedOnly}
          onChange={(next) => {
            if (!next) {
              setSnoozedOnly(false);
              return;
            }
            setSnoozedOnly(true);
          }}
        />
        <AlertsOpenChipRow
          value={openOnly}
          onChange={(next) => {
            if (!next) {
              setOpenOnly(false);
              return;
            }
            setOpenOnly(true);
            setOwnedByMe(false);
            setRemediatedOnly(false);
            setSnoozedOnly(false);
          }}
        />
        <section
          aria-label="Filter alerts by date range, sort, and search"
          className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:justify-between"
        >
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <AlertsDateRangeInput
              key={dateRangePreset ?? 'custom'}
              initialFrom={initialSearchParams.get('from') ?? ''}
              initialTo={initialSearchParams.get('to') ?? ''}
              basePath={basePath}
            />
            <AlertsSortSelect value={sort} onChange={setSort} />
            <AlertsTextQueryInput
              initialValue={initialSearchParams.get('q') ?? ''}
              basePath={basePath}
            />
          </div>
        </section>

        {q ? <AlertsSearchQueryBadge value={q} /> : null}

        <AlertsCountBadges counts={alertsData?.counts ?? null} />

        {alertsData ? (
          alertsData.items.length === 0 ? (
            <Card className="border-border/80 bg-card shadow-sm">
              <CardContent className="p-6 text-center text-body text-muted-foreground">
                No alerts match these filters on this host.
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-caption text-muted-foreground">
                {alertsData.total} {alertsData.total === 1 ? 'alert' : 'alerts'} on this host
              </p>
              <div className="md:hidden">
                <AlertsListCards
                  items={alertsData.items}
                  pendingReopenId={reopenPendingId}
                  onReopened={handleReopen}
                  pendingFalsePositiveId={fpSubmittingFor}
                  onFalsePositive={openFalsePositiveDialogSingle}
                />
              </div>
              <div className="hidden md:block">
                <AssetDetailAlertsTable
                  items={alertsData.items}
                  reopenPendingId={reopenPendingId}
                  fpSubmittingFor={fpSubmittingFor}
                  onReopen={handleReopen}
                  onOpenFalsePositive={openFalsePositiveDialogSingle}
                />
              </div>
            </div>
          )
        ) : (
          <AlertListSkeleton />
        )}
      </section>

      {/* Lifecycle block — the risk-score trend sparkline +
          remediation timeline pair. Mounted IMMEDIATELY AFTER
          the alerts list so the operator reads severity context
          first and then sees the lifecycle footprint; the
          false-positive and reopen dialogs are PAGE-wide
          overlays so they keep their presentational mount at
          the bottom of the tree. The sparkline + timeline are
          host-scoped only — chip-row changes on the alerts
          list above do NOT re-fire either island. Both have
          their own mount-keyed-on-host fetch so a navigation
          between /assets/<host-A> and /assets/<host-B>
          re-fires them in lockstep. The sparkline renders ABOVE
          the timeline so the operator patterns the "how has
          this host's exposure shifted?" trend and the "how
          have we been closing it?" history as a single
          screenshot pair. */}
      <section
        aria-labelledby="asset-lifecycle-heading"
        className="flex flex-col gap-3"
        data-testid="asset-lifecycle-section"
      >
        <h2
          id="asset-lifecycle-heading"
          className="sr-only font-display text-h3 tracking-tight text-foreground"
        >
          Lifecycle
        </h2>
        <AssetRiskTrendSparkline host={host} />
        {/* Remediation timeline — host-scoped introspection surface
            that shows a chronological chart of resolved + remediated
            events on the same host. Bits of detail:
            - The island's fetch is mount-keyed on `host` — chip-row
              changes on the alerts section above do NOT re-fire
              the timeline (the envelope is host-scoped only).
            - The `asset-remediation-section` `data-testid` is
              preserved from the prior single-block posture so
              any tests / e2e selectors continue to scope to it. */}
        <section
          aria-labelledby="asset-remediation-heading"
          className="flex flex-col gap-3"
          data-testid="asset-remediation-section"
        >
          <h2
            id="asset-remediation-heading"
            className="sr-only font-display text-h3 tracking-tight text-foreground"
          >
            Remediation timeline
          </h2>
          <AssetRemediationTimeline host={host} />
        </section>
      </section>

      {/* False-positive dialog — controlled by the page so the per-row
          button on /assets/<host> and a future bulk CTA share the same
          presentational mount. Mirrors /alerts/page.tsx:1823-1839
          verbatim except that there's no per-row path component to
          thread: each false-positive gesture on this page opens via
          `openFalsePositiveDialogSingle(id)` only. The dialog reads
          `targetLabel` from `fpDialogTargetLabel` so the operator sees
          "this alert" copy that maps to the per-row id. */}
      <AlertsFalsePositiveDialog
        open={fpDialogOpen}
        onOpenChange={(next) => {
          if (fpSubmitting && !next) return;
          setFpDialogOpen(next);
          if (!next) setFpDialogTarget(null);
        }}
        onSubmit={handleFalsePositiveSubmit}
        submitting={fpSubmitting}
        targetLabel={fpDialogTargetLabel}
      />

      {/* Reopen dialog — unused in the per-row POST path on this page
          because the inline Reopen button writes the bare `{}` body
          (parity with /alerts). Mounted as `closed` so future bulk
          posture can drive the dialog open without an extra page-side
          import. The dialog shows up empty on first paint — a benign
          no-op until a future escalation wires a per-row reason
          prompt or the bulk-bar's "Reopen selected" CTA. Present
          here for radius-completeness; explicitly avoids a re-mount
          on every row toggle because its `onOpenChange` listener
          immediately closes on `false`. */}
      <AlertsReopenDialog
        open={false}
        onOpenChange={() => {
          /* no-op on the asset-detail v1; reopen uses the inline bare-
              body POST, mirroring /alerts/<id>'s per-id reopen
              composer. */
        }}
        onSubmit={async () => {
          /* no-op */
        }}
        submitting={false}
        targetLabel=""
      />
    </div>
  );
}

function UnresolvedAlertsCard({
  data,
  error,
  loading,
}: {
  data: AlertList | null;
  error: string | null;
  loading: boolean;
}) {
  return (
    <section aria-labelledby="asset-unresolved-alerts-heading">
      <Card className="border-border/80 bg-card shadow-sm">
        <CardHeader className="space-y-1">
          <CardTitle
            id="asset-unresolved-alerts-heading"
            className="font-display text-h3 tracking-tight text-foreground"
          >
            Unresolved alerts
          </CardTitle>
          <CardDescription>
            Open and in-progress findings currently associated with this asset.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex flex-col gap-3">
              {['unresolved-sk-0', 'unresolved-sk-1', 'unresolved-sk-2'].map((key) => (
                <Skeleton key={key} className="h-16 w-full" />
              ))}
            </div>
          ) : error ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-3 text-body text-destructive"
            >
              Couldn’t load unresolved alerts. Try refreshing the page.
            </div>
          ) : data && data.items.length === 0 ? (
            <p className="rounded-md border border-dashed border-border/80 bg-muted/30 px-3 py-3 text-body font-medium text-muted-foreground">
              No unresolved alerts for this asset.
            </p>
          ) : data ? (
            <div className="flex flex-col divide-y divide-border">
              <p className="pb-3 text-caption text-muted-foreground">
                {data.total > data.items.length
                  ? `Showing ${data.items.length} of ${data.total} unresolved alerts.`
                  : `${data.total} ${data.total === 1 ? 'unresolved alert' : 'unresolved alerts'}.`}
              </p>
              {data.items.map((item) => {
                const title = item.vulnerabilityTitle?.trim() || item.cveId || 'Untitled alert';
                return (
                  <div
                    key={item.id}
                    className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
                  >
                    <div className="min-w-0">
                      <p className="break-words text-body font-medium text-foreground">{title}</p>
                      {item.cveId ? (
                        <p className="mt-1 break-all font-mono text-caption text-muted-foreground">
                          {item.cveId}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <Badge
                        variant={severityVariant(item.severity)}
                        className="font-mono uppercase tracking-wider"
                      >
                        {item.severity ?? 'unknown'}
                      </Badge>
                      <Button asChild variant="link" size="sm" className="px-0">
                        <Link
                          href={`/alerts/${item.id}`}
                          className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        >
                          View details
                        </Link>
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

// Desktop alert rows for the asset-detail drill-down. Sister to the
// mobile `<AlertsListCards>` mounted right above — same props shape
// (items + per-row reopen + per-row false-positive handlers) so the
// two breakpoints read as one card family. Selection / checkbox /
// bulk-bar are intentionally out of v1 scope per the brief (per-row
// gestures only); the future expansion introduces a shared
// `<AlertItemsList>` shell.
function AssetDetailAlertsTable({
  items,
  reopenPendingId,
  fpSubmittingFor,
  onReopen,
  onOpenFalsePositive,
}: {
  items: AlertList['items'];
  reopenPendingId: string | null;
  fpSubmittingFor: string | null;
  onReopen: (id: string) => Promise<void> | void;
  onOpenFalsePositive: (id: string) => void;
}) {
  return (
    <Card className="border-border/80 bg-card shadow-sm">
      <CardContent className="flex flex-col divide-y divide-border">
        {items.map((item) => {
          const sb = (() => {
            if (item.status === 'open') return { label: 'Open', variant: 'outline' as const };
            if (item.status === 'in_progress')
              return { label: 'In progress', variant: 'secondary' as const };
            if (item.status === 'resolved')
              return { label: 'Resolved', variant: 'secondary' as const };
            return { label: 'False positive', variant: 'destructive' as const };
          })();
          return (
            <div key={item.id} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  {item.cveId ? (
                    <a
                      href={`https://nvd.nist.gov/vuln/detail/${item.cveId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-body text-foreground underline-offset-2 hover:underline"
                    >
                      {item.cveId}
                    </a>
                  ) : (
                    <span className="font-mono text-muted-foreground">—</span>
                  )}
                  <p className="font-mono text-caption text-muted-foreground">
                    {item.asset.host}:{item.asset.port}/{item.asset.protocol}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge
                    variant={severityVariant(item.severity)}
                    className="font-mono uppercase tracking-wider"
                  >
                    {item.severity ?? 'unknown'}
                  </Badge>
                  <Badge variant={sb.variant} className="font-mono uppercase tracking-wider">
                    {sb.label}
                  </Badge>
                  {item.remediatedAt ? (
                    <Badge variant="outline" className="font-mono text-caption text-brand-600">
                      Remediated
                    </Badge>
                  ) : null}
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-caption text-muted-foreground">
                  {formatTimestamp(item.createdAt)}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <Button asChild variant="link" size="sm" className="px-0">
                    <Link href={`/alerts/${item.id}`}>View details</Link>
                  </Button>
                  {item.status === 'resolved' ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void onReopen(item.id)}
                      disabled={reopenPendingId === item.id}
                      aria-disabled={reopenPendingId === item.id}
                      className="px-3"
                    >
                      {reopenPendingId === item.id ? (
                        <>
                          <Loader2 className="size-4 animate-spin" aria-hidden /> Reopening…
                        </>
                      ) : (
                        'Reopen'
                      )}
                    </Button>
                  ) : null}
                  {item.status !== 'false_positive' ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onOpenFalsePositive(item.id)}
                      disabled={fpSubmittingFor === item.id}
                      aria-disabled={fpSubmittingFor === item.id}
                      className="px-3"
                    >
                      {fpSubmittingFor === item.id ? (
                        <>
                          <Loader2 className="size-4 animate-spin" aria-hidden /> Marking…
                        </>
                      ) : (
                        'Mark false positive'
                      )}
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// Loading skeleton — full page render. The header card skeleton
// mirrors the loaded card's 3-column outer + 5-column inner tile
// layout so the on-screen handoff has no jump. The alert list
// skeleton mirrors the chip band + a few row silhouettes.
function AssetDetailSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <div className="sticky top-14 z-30 -mx-gutter bg-background/95 px-gutter py-2 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <Skeleton className="h-8 w-32" />
      </div>
      <Card className="border-border/80 bg-card shadow-sm">
        <CardHeader className="space-y-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-7 w-64" />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {SKELETON_KEYS.map((key) => (
              <Skeleton key={key} className="h-12 w-full" />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-5 w-20" />
          </div>
        </CardContent>
      </Card>
      <Card className="border-border/80 bg-card shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 space-y-0 pb-3">
          <Skeleton className="size-4" />
          <Skeleton className="h-4 w-28" />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <Skeleton className="h-3 w-20" />
            <div className="flex items-center gap-3">
              <Skeleton className="h-5 w-44" />
              <Skeleton className="h-5 w-20" />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3 w-36" />
            {['sk-s-0', 'sk-s-1', 'sk-s-2'].map((key) => (
              <Skeleton key={key} className="h-9 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    </div>
  );
}

function AlertListSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      <Skeleton className="h-4 w-40" />
      <div className="flex flex-col gap-2">
        {['sk-r-0', 'sk-r-1', 'sk-r-2', 'sk-r-3'].map((rowKey) => (
          <Skeleton key={rowKey} className="h-20 w-full" />
        ))}
      </div>
    </div>
  );
}

// URL-state parser — same body as /alerts/page.tsx:183-367 with the
// `asset` Set removed since the per-host drill-down never lets the
// caller change the host via the chip strip; host is the path
// segment. Reads every filter chip the /alerts page reads so a
// permalink on either page lands on the equivalent chip-banded view.
// `openOnly` still claims `?status=open` and strips it from the
// AlertQuery parse; the enum's `status` chip row's `Open` chip is
// excluded from the wire-key family per /alerts/page.tsx:184-292.
function parseFiltersFromParams(sp: URLSearchParams): {
  severity: Set<SeverityLiteral> | null;
  status: StatusFilter;
  triggeredBy: SourceFilter;
  hideSnoozed: boolean;
  ownedByMe: OwnedByMeFlag;
  remediatedOnly: RemediatedOnlyFlag;
  snoozedOnly: SnoozedOnlyFlag;
  openOnly: OpenOnlyFlag;
  dateRangePreset: DateRangePreset;
  sort: AlertSortKey;
  since: SinceFilter;
  q: string | null;
} {
  const openOnlyRaw = sp.get('status');
  const openOnlyClaimed = openOnlyRaw === 'open';
  const rawQuery = Object.fromEntries(sp.entries());
  if (openOnlyClaimed) {
    delete (rawQuery as Record<string, unknown>).status;
  }
  const parsed = AlertQuery.safeParse(rawQuery);
  if (!parsed.success) {
    return {
      severity: null,
      status: null,
      triggeredBy: null,
      hideSnoozed: false,
      ownedByMe: false,
      remediatedOnly: false,
      snoozedOnly: false,
      openOnly: openOnlyClaimed,
      dateRangePreset: null,
      sort: 'lastActivity',
      since: null,
      q: null,
    };
  }
  const fromStr = sp.get('from') ?? '';
  const toStr = sp.get('to') ?? '';
  const todayIso = new Date().toISOString().slice(0, 10);
  const preset = matchDateRangePreset(fromStr, toStr, todayIso);
  const sort = parsed.data.sort;
  const severityArr = parseSeverityFilter(parsed.data.severity ?? null);
  return {
    severity: severityArr.length > 0 ? new Set(severityArr) : null,
    status: (parsed.data.status as StatusFilter | undefined) ?? null,
    triggeredBy: (parsed.data.triggeredBy as SourceFilter | undefined) ?? null,
    hideSnoozed: parsed.data.hideSnoozed === '1',
    ownedByMe: sp.get('ownedByMe') === '1',
    remediatedOnly: sp.get('remediated') === '1',
    snoozedOnly: sp.get('snoozed') === '1',
    openOnly: openOnlyClaimed,
    dateRangePreset: preset,
    sort,
    since: (parsed.data.since as SinceFilter | undefined) ?? null,
    q: parsed.data.q ?? null,
  };
}

function matchDateRangePreset(from: string, to: string, todayIso: string): DateRangePreset {
  if (!from || !to) return null;
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  if (from === daysAgo(7) && to === todayIso) return '7d';
  if (from === daysAgo(30) && to === todayIso) return '30d';
  if (from === daysAgo(90) && to === todayIso) return '90d';
  return null;
}
