// @polsia:user-owned — Alerts dashboard. Client island that fetches one
// `AlertList` envelope from /api/alerts via apiFetch and renders an
// alerts table (Severity, CVE ID, Asset, Timestamp, Source, Triggered by,
// Details). The page does NOT call requireAuth itself — DashboardShell
// already redirects unauthenticated users to /login, and
// requireTeamRole('member') in /api/alerts is the only access-control
// gate.
//
// URL contract: severity, status, triggeredBy, hideSnoozed, ownedByMe, asset, q,
// from, to, since, sort are all persisted in the query string so a filtered
// view is shareable and a downloadable CSV inherits the visible-table
// ordering. Chip clicks fire a new fetch and `router.replace`'s into the
// same string with `scroll: false` so the back button still leaves /alerts
// instead of stepping through every state. The text-query and date-range
// inputs are each their OWN URL-state islands (`alerts-text-query-input`
// and `alerts-date-range-input`) — they own `q` / `from` / `to` directly
// on the URL, and the page's chip writer preserves those keys by reading
// them out of the current `searchParams` on every chip change. Result:
// a chip click never silently wipes a typed `q`, and a typed `q` never
// wipes a chip-state. `sort` rides the same `effectiveQs` writer so the
// sort dropdown, the chip rows, and the CSV download anchor all stay in
// lockstep — the export endpoint parses the same `AlertQuery` contract
// and applies the same keyset / orderBy branch on its side.
// `hideSnoozed=1` is the literal-form URL key for the snooze toggle
// (default-show; absent keeps snoozed rows visible). The setter shape
// is a boolean the route mirrors into the literal `'1'` on the wire.
// `asset=<csv>` is the multi-select composite `${host}:${port}/${protocol}`
// filter — applied as `finding: { asset: { OR: [{host,port,protocol}, ...] } }`
// in /api/alerts AND /api/alerts/export.csv so a filtered view downloads a
// matching file. The chip row sources its options from
// `/api/alerts/asset-options` (top-N distinct assets per team, ordered by
// frequency desc with name asc tiebreak) so the same view that the
// /assets rollup produces matches what the operator toggles into the
// filter here. The wire identity is the same composite `${host}:${port}
// /${protocol}` already produced by `/assets-table`'s `/alerts?asset=…`
// deep-link — that link is a no-op today (the alerts page ignores the
// key); this filter turns it into a real narrowing.
//
// Selection (`?selected=`) rides alongside the chip-state, but ONLY when
// the operator toggles a row's checkbox. It IS read OUTSIDE AlertQuery
// (mirror of `ownedByMe`) so the export endpoint stays decoupled from the UI
// selection. Selection is cleared on any view-change key flip (severity,
// status, triggeredBy, ownedByMe, hideSnoozed, asset, q, from, to, since,
// sort) — a future view that doesn't carry over the pre-flip working set
// would silently stale-resolve rows the user can no longer see, so the
// contract is "selection survives only within a single visible-row-set
// view".

'use client';

import { Bell, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CommentsCountBadge } from '@/components/custom/alerts/comments-count-badge';
import { SendSnoozeDigestButton } from '@/components/custom/alerts/send-snooze-digest-button';
import { TrendingBadge } from '@/components/custom/alerts/trending-badge';
import { AlertAge, formatAlertCreatedAt } from '@/components/dashboard/alert-age';
import {
  AlertsAssetChipRow,
  type AssetFilterOption,
} from '@/components/dashboard/alerts-asset-chip-row';
import {
  AlertsBulkActionBar,
  type BulkRowOutcome,
} from '@/components/dashboard/alerts-bulk-action-bar';
import { AlertsCountBadges } from '@/components/dashboard/alerts-count-badges';
import {
  AlertsDateRangeChipRow,
  type DateRangePreset,
} from '@/components/dashboard/alerts-date-range-chip-row';
import { AlertsDateRangeInput } from '@/components/dashboard/alerts-date-range-input';
import { AlertsExportButton } from '@/components/dashboard/alerts-export-button';
import { AlertsFalsePositiveDialog } from '@/components/dashboard/alerts-false-positive-dialog';
import { AlertsHighRiskAssetsChipRow } from '@/components/dashboard/alerts-high-risk-assets-chip-row';
import { AlertsHostnameSearchInput } from '@/components/dashboard/alerts-hostname-search-input';
import { AlertsListCards } from '@/components/dashboard/alerts-list-cards';
import { AlertsListStatus } from '@/components/dashboard/alerts-list-status';
import type { OpenOnlyFlag } from '@/components/dashboard/alerts-open-chip-row';
import {
  AlertsOwnerChipRow,
  type OwnedByMeFlag,
} from '@/components/dashboard/alerts-owner-chip-row';
import {
  AlertsRemediatedChipRow,
  type RemediatedOnlyFlag,
} from '@/components/dashboard/alerts-remediated-chip-row';
import { AlertsReopenDialog } from '@/components/dashboard/alerts-reopen-dialog';
import { AlertsResolutionChipRow } from '@/components/dashboard/alerts-resolution-chip-row';
import { AlertsResolveDialog } from '@/components/dashboard/alerts-resolve-dialog';
import type { ResolvedOnlyFlag } from '@/components/dashboard/alerts-resolved-chip-row';
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/auth-client';
import { parseAssetFilter } from '@/lib/business/alerts-asset';
import { runBulkAssignOwner } from '@/lib/business/alerts-bulk-assign-owner';
import { runBulkFalsePositive } from '@/lib/business/alerts-bulk-false-positive';
import { runBulkTakeOwnership } from '@/lib/business/alerts-bulk-ownership';
import { runBulkRemediate } from '@/lib/business/alerts-bulk-remediate';
import { runBulkReopen } from '@/lib/business/alerts-bulk-reopen';
import { runBulkResolve } from '@/lib/business/alerts-bulk-resolve';
import { runBulkResolveBatch } from '@/lib/business/alerts-bulk-resolve-batch';
import { runBulkSnooze } from '@/lib/business/alerts-bulk-snooze';
import {
  buildAlertPageHref,
  buildEffectiveQs,
  parseAlertWorkflowStatus,
} from '@/lib/business/alerts-effective-qs';
import { buildAlertDetailHref } from '@/lib/business/alerts-navigation';
import { parseSelectedParam } from '@/lib/business/alerts-selection';
import { parseSeverityFilter, type SeverityLiteral } from '@/lib/business/alerts-severity';
import type { SinceFilter } from '@/lib/business/alerts-since';
import { applyAlertStatusMutation } from '@/lib/business/alerts-status-reconcile';
import { AlertDateBound } from '@/lib/contracts/alert-date-range';
import {
  AlertFalsePositiveResponse,
  AlertList,
  AlertQuery,
  AlertResolveResponse,
  type AlertSortKey,
  type AlertStatusMutationResponse,
  AssetFilterOptions,
  type ResolutionFilter,
} from '@/lib/contracts/alerts';
import { type MemberOption, MemberOptionList } from '@/lib/contracts/team';
import { scanSourceLabels } from '@/lib/scan-source-labels';

function severityVariant(sev: string | null): 'destructive' | 'secondary' | 'outline' {
  const s = (sev ?? '').toLowerCase();
  if (s === 'critical' || s === 'high') return 'destructive';
  if (s === 'medium') return 'secondary';
  return 'outline';
}

function sourceVariant(
  source: 'kev' | 'vulncheck' | 'manual',
): 'destructive' | 'secondary' | 'outline' {
  if (source === 'kev') return 'destructive';
  if (source === 'manual') return 'outline';
  return 'secondary';
}

// 60-second aging tick keeps the new "Last activity" column's relative
// ages from going stale — older rows re-evaluate "3 minutes ago" → "4
// minutes ago" inside the open tab without a refetch. Cheap; cleans up
// on unmount.
const RELATIVE_TICK_MS = 60_000;
const ACTIVE_WORKSPACE_CHANGED_EVENT = 'active-workspace-changed';

// Bucket + formatter for the "<N> seconds ago" stamp in the new column.
// Mirror of alert-notes-card.tsx:64-83 + alert-comments-card.tsx:60-78
// (kept inline rather than factored out so the diff stays scoped — see
// the brief's "out of scope" list for `formatRelative` extraction).
const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

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

const SKELETON_ROW_KEYS = ['sk-0', 'sk-1', 'sk-2', 'sk-3', 'sk-4', 'sk-5', 'sk-6', 'sk-7'];

function parseFiltersFromParams(sp: URLSearchParams): {
  // Multi-select severity filter — `null` = chip on "All", non-empty
  // Set = the page-level chip-state mirrors the URL's parsed
  // literals (`?severity=critical,high` lands here as `{critical,
  // high}`; a single-literal permalink from the dashboard tile
  // lands at a single-element Set). Every parsed literal from
  // `parseSeverityFilter` flows INTO the Set — there's no "first
  // chip wins" collapse any more. The writer emits the canonical
  // critical → high → medium → low CSV via `formatSeverityFilter`
  // so a permalink stays stable across permutations of chip
  // clicks.
  severity: Set<SeverityLiteral> | null;
  resolution: ResolutionFilter | undefined;
  status: StatusFilter;
  triggeredBy: SourceFilter;
  hideSnoozed: boolean;
  highRiskAssets: boolean;
  ownedByMe: OwnedByMeFlag;
  // Multi-select asset filter — `null` = no chip active, non-empty
  // Set = the page-level chip-state mirrors the URL's alphabetical
  // canonical CSV (a permalink like `/alerts?asset=foo,bar` lands
  // here as `{ foo, bar }`). Same wire shape the /assets rollup's
  // `/alerts?asset=<encoded name>` deep-link produces — turning that
  // previously-noop key into a real narrowing is the brief's
  // acceptance criterion #1.
  asset: Set<string> | null;
  // Boolean-flag filter for remediated rows only. Mirrors `ownedByMe`
  // exactly — `true` means only `Alert.remediatedAt IS NOT NULL` rows
  // are returned; `false` (the resting state) strips the key from the
  // URL so a chip click never silently drops text input state.
  remediatedOnly: RemediatedOnlyFlag;
  // Boolean-flag filter for snoozed rows only — narrows to rows with
  // an ACTIVE snooze window (`snoozedUntil > now`). The resting
  // `false` state strips the key from the URL so a chip click never
  // silently drops text input state. The wire shape is the
  // boolean-flag literal `'1'` only, reading
  // `sp.get('snoozed') === '1'` (any other value parses as
  // absent). Byte-matches the bulk-resolve / claim "exclude future
  // snoozes" posture so the chip surfaces exactly the rows a snooze
  // stamp would hold back from the bulk-resolve working set.
  // Composes with the other filter chips, severity, source, asset,
  // and the text/date inputs — activating Snoozed
  // does NOT clear any of the other chip families; toggling off
  // removes only this arm.
  snoozedOnly: SnoozedOnlyFlag;
  // Internal alias for status=open. The status row still owns the
  // single visible control; this flag lets the API retain its special
  // active-snooze exclusion for Open.
  openOnly: OpenOnlyFlag;
  // Internal alias for status=resolved retained for query composition.
  resolvedOnly: ResolvedOnlyFlag;
  // Derived on the client from the URL's `from` / `to` keys: the preset
  // lights up only when those two strings match a today's-relative window
  // (yyyy-mm-dd slices of `today - N days` and `today`). A typed custom
  // range falls back to `null` so the chip row visibly drops to "All" —
  // the preset is a client-side concept, never round-tripped through the
  // route's AlertQuery schema. Comparison uses the client's "now",
  // matching the date-input's slice semantics so a freshly-mounted tab and
  // an active preset always agree on what "Last 7d" means.
  dateRangePreset: DateRangePreset;
  // Sort mode — driven by `?sort=`. Default `newest` matches the route's
  // zod default, so a freshly-pasted URL with no `sort` key lands the
  // operator in the "Newest first" branch 1:1.
  sort: AlertSortKey;
  // Trailing-N-days chip — `null` = no filter, `'7d'` = last 7 days.
  // The wire-side enum is widened to ('7d','30d','90d') so adding a
  // preset later doesn't reshape the contract; the page ships only
  // '7d' on the chip row for v1.
  since: SinceFilter;
  // Free-form text query — `null` means no active query. Mirrors the
  // brief's "ILIKE on findingTitle + join on Asset.hostname" two-arm
  // search; populated from `parsed.data.q` (the zod trim+min(1)+max(200)
  // contract already gates tampered URLs from leaking to the badge mount).
  // Used by AlertsSearchQueryBadge for the chip-band removable badge
  // and by the page's `parseFiltersFromParams(...).q` lazy-init so the
  // badge reads from the same source the chip rows read from.
  q: string | null;
} {
  // Server writes the same AlertQuery schema over a query string;
  // safeParse here keeps the client and server parsing identical, and any
  // unparseable value (a typo'd `severity=critcal` etc.) silently drops to
  // null rather than firing a 400-producing fetch.
  // `ownedByMe` is read OUTSIDE the AlertQuery zod schema — matches
  // /api/alerts/export.csv/route.ts, which keeps the variant semantics in
  // the route file and decouples the page-filter shape from the export
  // contract. The wire shape is the boolean-flag literal `'1'`.
  // `hideSnoozed` is the boolean URL-state derived from the route's
  // zod `z.literal('1').optional()` — only `?hideSnoozed=1` flips the
  // toggle on; any other form (e.g. `?hideSnoozed=true` or absent)
  // parses as absent, default `false` (snoozed rows visible).
  // `status=open` uses the existing open-only API predicate, so parse
  // it separately and map it back to the Open option in the shared row.
  const statusFromUrl = parseAlertWorkflowStatus(sp.get('status'));
  const openOnlyClaimed = statusFromUrl === 'open';
  const rawQuery = Object.fromEntries(sp.entries());
  if (typeof rawQuery.from === 'string' && !AlertDateBound.safeParse(rawQuery.from).success) {
    delete rawQuery.from;
  }
  if (typeof rawQuery.to === 'string' && !AlertDateBound.safeParse(rawQuery.to).success) {
    delete rawQuery.to;
  }
  if (openOnlyClaimed) {
    delete (rawQuery as Record<string, unknown>).status;
  }
  const parsed = AlertQuery.safeParse(rawQuery);
  if (!parsed.success) {
    return {
      severity: null,
      resolution: undefined,
      status: null,
      triggeredBy: null,
      hideSnoozed: false,
      highRiskAssets: false,
      ownedByMe: false,
      remediatedOnly: false,
      snoozedOnly: false,
      openOnly: openOnlyClaimed,
      resolvedOnly: false,
      asset: null,
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
  // `parsed.data.sort` is the post-transform, post-default value the
  // AlertQuery zod schema stamps — `'lastActivity'` on an absent key
  // (the new brief default), `'created'` on both a `?sort=created`
  // URL and the legacy `?sort=newest` permalink (the schema maps the
  // latter via `.transform`), and one of `'severity' | 'status' |
  // 'lastActivity'` for the explicitly-emitted variants. Read
  // THAT rather than re-running `isAlertSortKey(rawSort)` so a
  // legacy `?sort=newest` visitor lands on `created` (the schema's
  // transform already normalized it) instead of falling through to
  // the `'lastActivity'` default.
  const sort = parsed.data.sort;
  const severityArr = parseSeverityFilter(parsed.data.severity ?? null);
  const resolution = parsed.data.resolution;
  // `asset` is a free-form-validity comma list at the schema layer; the
  // route's strict shape check (host:port/protocol) is a server-side
  // 400. The page-level parser is permissive (alphabetical canonical,
  // dedupe, drop blanks) so a permalink with a typo'd entry silently
  // narrows to zero server-side but the page chip row keeps the rest
  // of the Set. The route's `parseAssetNamesToOrList` is the strict
  // shape validator; the page mirrors the lenient version so a
  // partially-typed chip set doesn't drop on every paste.
  const assetArr = parseAssetFilter(parsed.data.asset ?? null);
  // `openOnlyClaimed` retains the API's Open predicate while the
  // shared status row displays the corresponding `open` selection.
  const status = (statusFromUrl as StatusFilter | null) ?? null;
  // Resolve the dedicated chip from the status literal. Open and
  // Resolved share this URL key, so only one can be active at a time.
  const resolvedOnlyClaimed = status === 'resolved';
  return {
    // Multi-select: every parsed literal from `parseSeverityFilter`
    // flows into a Set — no "first chip wins" collapse. A legacy
    // multi-value CSV permalink (`?severity=critical,high`) lights
    // both chips on first mount; the dashboard-tile single-literal
    // permalink (`?status=open&severity=critical`) lights only the
    // Critical chip; an unknown / typo'd literal is silently
    // preserved by `parseSeverityFilter` so stored custom values remain
    // selectable instead of being mapped into a standard bucket.
    severity: severityArr.length > 0 ? new Set(severityArr) : null,
    resolution,
    status,
    triggeredBy: (parsed.data.triggeredBy as SourceFilter | undefined) ?? null,
    hideSnoozed: parsed.data.hideSnoozed === '1',
    highRiskAssets: parsed.data.highRiskAssets === '1',
    ownedByMe: sp.get('ownedByMe') === '1',
    remediatedOnly: sp.get('remediated') === '1',
    snoozedOnly: sp.get('snoozed') === '1',
    openOnly: openOnlyClaimed,
    resolvedOnly: resolvedOnlyClaimed,
    asset: assetArr.length > 0 ? new Set(assetArr) : null,
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

// Wrap the inner island in <Suspense> so useSearchParams() doesn't escape
// to the route-level error boundary on Chromium. Next.js 16 turns the
// missing-Suspense case into an SSR/hydration throw on Chrome/Edge (V8
// hydration contract is strict), but Firefox/Safari's HTML pipeline lets
// the lazy useState init read the params without throwing — that's the
// "Chrome/Edge only" symptom we saw on vulnaware.polsia.io. The fallback
// is null while the first render is in flight so DashboardShell's own
// skeleton/redirect stays consistent.
export default function AlertsPage() {
  return (
    <Suspense fallback={null}>
      <AlertsPageInner />
    </Suspense>
  );
}

function AlertsPageInner() {
  const initialSearchParams = useSearchParams();
  const detailQueryString = initialSearchParams.toString();
  const router = useRouter();
  // Session — sourced from the same `useSession()` the DashboardShell
  // already wraps (mirroring the parent's session flow so the alerts
  // island never round-trips its own `/api/auth/get-session` fetch).
  // The reactive shape (`session?.user?.email`) is what the optimistic
  // flip's `callerEmail` reads on a re-render; the imperative
  // `callerEmailRef.current` mirrors it for the
  // `useCallback`-wrapped handler (the callback closes over a stale
  // reference value otherwise — see submitBulkRemediate below).
  const { data: session } = useSession();
  const callerEmailRef = useRef<string | null>(session?.user?.email ?? null);
  // Sync the ref off every session.user.email flip so the imperative
  // handle reads the latest value when submitBulkRemediate fires.
  // Effect-driven (NOT a `useState`) so the ref doesn't cause an
  // extra re-render of the page — the render is keyed off session
  // itself; this branch is purely imperative.
  useEffect(() => {
    callerEmailRef.current = session?.user?.email ?? null;
  }, [session?.user?.email]);
  // Caller WorkspaceMember + display name — imperative handles for
  // submitBulkTakeOwnership's optimistic flip. Mirrors
  // `callerEmailRef`'s posture: a ref + an effect-driven sync off
  // the session, so the useCallback's closure reads the latest
  // value when the bulk-take handler fires (a stale closure would
  // short-circuit the flip on a session refresh). The initial
  // values resolve from /api/team/membership on mount via a memo'd
  // promise so a freshly-mounted tab and a session re-hydration
  // both converge on the same `id`; null on submit-time means the
  // caller is not an active team member and the route would 404
  // anyway, so the handler short-circuits silently.
  const callerWorkspaceMemberIdRef = useRef<string | null>(null);
  const callerNameRef = useRef<string | null>(null);
  useEffect(() => {
    if (!session?.user?.id) {
      callerWorkspaceMemberIdRef.current = null;
      callerNameRef.current = null;
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/team/membership', { cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as { id: string; name: string | null };
        if (cancelled) return;
        callerWorkspaceMemberIdRef.current = body.id ?? null;
        callerNameRef.current = body.name ?? null;
      } catch {
        // Network reset / JSON parse on a non-JSON response — keep
        // the refs null so the bulk-take handler short-circuits
        // silently. The route would 500 on a missing roster row
        // anyway, so the page doesn't need to surface a toast.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);

  const [data, setData] = useState<AlertList | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Asset chip-list options shadow state — populated off
  // `/api/alerts/asset-options`, top-N distinct assets on the team
  // with per-asset alert count, ordered by frequency desc. The chip
  // row's options prop reads this directly. Defaults to `[]` so the
  // row never crashes on first render before fetch resolves.
  const [assetOptions, setAssetOptions] = useState<AssetFilterOption[]>([]);
  // Member roster shadow state — populated off `/api/team/members`
  // on mount once. Drives the bulk "Assign owner…" popover's option
  // list. Mirrors `alert-detail-client.tsx`'s posture: a single,
  // tiny roster fetch at mount time (the route is index-only and
  // returns `{items: MemberOption[]}`). Defaults to `[]` so the
  // bar's popover mounts an "empty" state rather than crashing on
  // first render before fetch resolves. The page owns this state;
  // the bulk bar reads `members` as a prop. Refresh on view-flip
  // is intentionally omitted — the roster is workspace-scoped and
  // rarely changes within a session.
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [sort, setSort] = useState<AlertSortKey>(
    () => parseFiltersFromParams(initialSearchParams).sort,
  );
  const [severity, setSeverity] = useState<Set<SeverityLiteral> | null>(
    () => parseFiltersFromParams(initialSearchParams).severity,
  );
  const [resolution, setResolution] = useState<ResolutionFilter | undefined>(
    () => parseFiltersFromParams(initialSearchParams).resolution,
  );
  const [status, setStatus] = useState<StatusFilter>(
    () => parseFiltersFromParams(initialSearchParams).status,
  );
  const [triggeredBy, setTriggeredBy] = useState<SourceFilter>(
    () => parseFiltersFromParams(initialSearchParams).triggeredBy,
  );
  const [hideSnoozed, setHideSnoozed] = useState<boolean>(
    () => parseFiltersFromParams(initialSearchParams).hideSnoozed,
  );
  const [highRiskAssets, setHighRiskAssets] = useState<boolean>(
    () => parseFiltersFromParams(initialSearchParams).highRiskAssets,
  );
  const [ownedByMe, setOwnedByMe] = useState<OwnedByMeFlag>(
    () => parseFiltersFromParams(initialSearchParams).ownedByMe,
  );
  const [remediatedOnly, setRemediatedOnly] = useState<RemediatedOnlyFlag>(
    () => parseFiltersFromParams(initialSearchParams).remediatedOnly,
  );
  // Boolean-flag state for the Snoozed-only chip. Lazy init reads
  // `?snoozed=1` on first mount and composes with the status row and
  // the other filters.
  // Activating Snoozed does NOT cross-clear anything; toggling off
  // drops only this arm so the previously combined filter state is
  // restored without a refresh.
  const [snoozedOnly, setSnoozedOnly] = useState<SnoozedOnlyFlag>(
    () => parseFiltersFromParams(initialSearchParams).snoozedOnly,
  );
  // Open remains an internal alias for the status row's `open` value
  // because its API predicate also excludes active snooze windows.
  const [openOnly, setOpenOnly] = useState<OpenOnlyFlag>(
    () => parseFiltersFromParams(initialSearchParams).openOnly,
  );
  // Resolved is initialized from status=resolved and shares the same
  // status URL key as the other workflow states.
  const [resolvedOnly, setResolvedOnly] = useState<ResolvedOnlyFlag>(
    () => parseFiltersFromParams(initialSearchParams).resolvedOnly,
  );
  // Multi-select asset chip state. Lazy init reads `?asset=foo,bar` on
  // first mount so a permalink from /assets lands the chip row
  // already-active (the brief's "deep-link round-trip" acceptance
  // criterion). Subsequent clicks ride the same effectiveQs useMemo
  // + useEffect chain as the sibling chip rows so URL ↔ state stay in
  // lockstep without a separate handleAsset router.replace.
  const [asset, setAsset] = useState<Set<string> | null>(
    () => parseFiltersFromParams(initialSearchParams).asset,
  );
  // Trailing-N-days chip state. Lazy init reads `?since=7d` on first
  // mount; subsequent clicks ride the same effectiveQs useMemo +
  // useEffect chain as the sibling chip rows so URL ↔ state stay in
  // lockstep without a separate handleSince router.replace.
  const [since, setSince] = useState<SinceFilter>(
    () => parseFiltersFromParams(initialSearchParams).since,
  );
  // Free-form text query — derive the active value from the live URL so
  // the badge and empty state update when the input island debounces a
  // new query or clears the current one. The input island is the only
  // writer — it owns q's URL write on every keystroke via
  // router.replace (after its 250ms debounce).
  const q = parseFiltersFromParams(initialSearchParams).q;
  // Selection (bulk-resolve working set) — hydrated from `?selected=`
  // on first mount via lazy init. The page's own URL writer mirrors it
  // back through `effectiveQs`; chip-row flips clear it via the
  // viewKey useEffect below so a stale working set never ships
  // against a filtered-clipped row range.
  const [selection, setSelection] = useState<Set<string>>(() =>
    parseSelectedParam(initialSearchParams),
  );
  // Tracks rows whose POST to /resolve is currently in flight. Drives
  // the bulk action bar's disabled-while-busy state and the per-row
  // "pending" indicator chip.
  const [pendingBulkIds, setPendingBulkIds] = useState<Set<string>>(new Set());
  // Per-row outcome map, populated by `submitBulkResolve` as
  // Promise.allSettled resolves. The bulk action bar reads this to
  // paint the green/red indicator strip; reset on every new fan-out.
  const [bulkResults, setBulkResults] = useState<Map<string, BulkRowOutcome>>(new Map());

  // "Last activity" column relative-time base. Refreshed on a 60s tick
  // so old rows visibly age inside the open tab (without a refetch).
  // Mount-time baseline avoids a 0→"0 seconds ago" flash on first
  // render. Mirror of alert-notes-card.tsx:now state.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => {
      setNow(Date.now());
    }, RELATIVE_TICK_MS);
    return () => {
      clearInterval(handle);
    };
  }, []);

  const dateRangePreset = useMemo<DateRangePreset>(
    () => parseFiltersFromParams(initialSearchParams).dateRangePreset,
    [initialSearchParams],
  );

  // View-key fingerprint — every URL writer that mutates the visible
  // row set rebroadcasts one of these keys. When the fingerprint
  // changes (after the first mount), drop the selection set: the new
  // view may not contain any of the previously-selected ids, and
  // shipping a resolve POST against an offscreen row would be a
  // silent stale-resolve. Selection rides its own `?selected=` key,
  // excluded from the fingerprint so a pure selection toggle does
  // NOT clear the working set.
  const viewKey = useMemo(() => {
    const p = new URLSearchParams(initialSearchParams.toString());
    p.delete('selected');
    return p.toString();
  }, [initialSearchParams]);
  // Skip the first effect call: we just hydrated `selection` from the
  // URL via lazy init, so the first viewKey change is the URL itself,
  // not a view change. After mount, every change to viewKey —
  // including a text-input keystroke (debounced 200ms by the input
  // island), a date-range flip, a chip click, etc. — drops the
  // working set.
  const clearedFirstViewRef = useRef(false);
  useEffect(() => {
    if (!clearedFirstViewRef.current) {
      clearedFirstViewRef.current = true;
      return;
    }
    // Touch `viewKey` so the dep is meaningful inside the effect
    // body — biome's `useExhaustiveDependencies` rule fires on
    // identity-only deps and would otherwise drop it from the list.
    void viewKey;
    setSelection(new Set());
    setBulkResults(new Map());
  }, [viewKey]);

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
      router.replace(`/alerts${qs ? `?${qs}` : ''}`, { scroll: false });
    },
    [initialSearchParams, router],
  );

  // Merge chip-state with the current URL's q/from/to/selected keys
  // (the text/date islands own q/from/to; selection is the bulk-resolve
  // working set). This is THE source of truth for both the URL write
  // below AND the apiFetch fetch — keeping them in lockstep is the
  // "rows match the visible list 1:1" guarantee for the export.
  // Extracted to buildEffectiveQs (`@/lib/business/alerts-effective-qs`)
  // so the URL round-trip can be unit-tested without rendering the page.
  // Adding `since` and `asset` to the writer is a single line below —
  // every other key rides the same composition rules (null/false strip;
  // toggle keys emit their non-default literal; CSV Set keys emit their
  // canonical CSV only when the Set is non-empty so a chip "Clear"
  // drops the key cleanly without touching `q`/`from`/`to`/severity).
  const effectiveQs = useMemo(
    () =>
      buildEffectiveQs(
        {
          severity,
          resolution,
          status,
          triggeredBy,
          hideSnoozed,
          highRiskAssets,
          ownedByMe,
          remediatedOnly,
          snoozedOnly,
          openOnly,
          resolvedOnly,
          sort,
          since,
          asset,
        },
        initialSearchParams,
        selection,
      ),
    [
      severity,
      resolution,
      status,
      triggeredBy,
      hideSnoozed,
      highRiskAssets,
      ownedByMe,
      remediatedOnly,
      snoozedOnly,
      openOnly,
      resolvedOnly,
      sort,
      since,
      asset,
      initialSearchParams,
      selection,
    ],
  );

  const emptyStateMessage = q
    ? `No authorized alerts match “${q}”. Try a different alert title or asset hostname.`
    : effectiveQs
      ? 'No alerts match the current filters.'
      : 'No alerts yet.';

  const updateUrl = useCallback(
    (nextQs: string) => {
      const nextUrl = `/alerts${nextQs}`;
      if (`${window.location.pathname}${window.location.search}` === nextUrl) return;
      router.replace(nextUrl, { scroll: false });
    },
    [router],
  );

  const navigatePage = useCallback(
    (nextPage: number) => {
      router.replace(buildAlertPageHref(effectiveQs, nextPage), { scroll: false });
    },
    [effectiveQs, router],
  );

  useEffect(() => {
    updateUrl(effectiveQs);
  }, [effectiveQs, updateUrl]);

  useEffect(() => {
    let active = true;
    let requestId = 0;

    const loadAlerts = (workspaceChanged = false) => {
      const currentRequestId = ++requestId;
      if (workspaceChanged) {
        // Clear the old workspace's rows immediately so they cannot be
        // mistaken for the newly selected scope while its server-derived
        // result is loading.
        setData(null);
        setSelection(new Set());
        setBulkResults(new Map());
      }
      setError(null);
      apiFetch(`/api/alerts${effectiveQs}`, { schema: AlertList })
        .then((payload) => {
          if (active && currentRequestId === requestId) setData(payload);
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          if (!active || currentRequestId !== requestId) return;
          setError(msg);
          toast.error('Could not load alerts.');
        });
    };

    const handleWorkspaceChanged = () => loadAlerts(true);
    loadAlerts();
    window.addEventListener(ACTIVE_WORKSPACE_CHANGED_EVENT, handleWorkspaceChanged);

    return () => {
      active = false;
      window.removeEventListener(ACTIVE_WORKSPACE_CHANGED_EVENT, handleWorkspaceChanged);
    };
  }, [effectiveQs]);

  // Fetch asset-options snapshot on mount + whenever the active
  // filter set changes — so a previously-unseen asset that appears
  // after a chip click lands in the option list on the next chip
  // render (the brief's "chip list refreshes when previously-unseen
  // assets appear on a refetch" criterion). Source-of-truth is the
  // filtered resultset (`effectiveQs`) so an asset hidden by an
  // active filter still has a path to re-surface when the user
  // clears that filter — the row-side muscle matches the chip-side
  // shape. Re-fetches on every `effectiveQs` change but the network
  // is member-gated, capped at 200 distinct assets, and the response
  // is tiny — well under the threshold where this would be a perf
  // concern.
  useEffect(() => {
    let active = true;
    // Touch `effectiveQs` so biome's `useExhaustiveDependencies` rule
    // doesn't drop it from the deps list — the dep IS load-bearing (a
    // value change should re-fetch the chip-list source so a
    // previously-unseen asset appears in the row), but the effect
    // body doesn't read it (the URL is the filter source). Same
    // comment-and-`void` pattern the page's `viewKey` effect uses
    // (above).
    void effectiveQs;
    apiFetch('/api/alerts/asset-options', { schema: AssetFilterOptions })
      .then((payload) => {
        if (active) setAssetOptions(payload.items);
      })
      .catch(() => {
        // The chip row renders empty (no options baked yet); the
        // data load is the page's primary concern. A misconfigured
        // gate or a transient network error here is non-fatal —
        // drop silently so a toast doesn't fire on every flaky
        // refetch when the alerts data is otherwise live.
        if (active) setAssetOptions([]);
      });
    return () => {
      active = false;
    };
  }, [effectiveQs]);

  const handleStatusSaved = useCallback((saved: AlertStatusMutationResponse) => {
    setData((current) =>
      current ? { ...current, items: applyAlertStatusMutation(current.items, saved) } : current,
    );
  }, []);

  // Fetch the member roster ONCE on mount. The roster drives the
  // bulk "Assign owner…" popover's option list — single fetch,
  // tiny payload, no viewKey-driven refresh (the roster is
  // workspace-scoped and rarely changes within a session). A
  // mount-time failure is non-fatal — the popover renders an
  // empty state so the user can fall back to per-row assignment
  // on /alerts/[id] until the next mount.
  useEffect(() => {
    let active = true;
    apiFetch('/api/team/members', { schema: MemberOptionList })
      .then((payload) => {
        if (active) setMembers(payload.items);
      })
      .catch(() => {
        if (active) setMembers([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const [reopenPendingId, setReopenPendingId] = useState<string | null>(null);

  const [pendingResolveId, setPendingResolveId] = useState<string | null>(null);

  const handleResolve = useCallback(
    async (id: string) => {
      if (!data || pendingResolveId) return;
      const row = data.items.find((item) => item.id === id);
      if (!row || row.status === 'resolved' || row.status === 'false_positive') return;

      setPendingResolveId(id);
      try {
        const resolved = await apiFetch(`/api/alerts/${id}/resolve`, {
          method: 'POST',
          body: JSON.stringify({}),
          schema: AlertResolveResponse,
        });
        if (resolved.status !== 'resolved') {
          toast.error('Could not resolve alert.');
          return;
        }

        setData((current) =>
          current
            ? {
                ...current,
                items: current.items.map((item) =>
                  item.id === id
                    ? {
                        ...item,
                        status: resolved.status,
                        acknowledgedAt: resolved.acknowledgedAt,
                        closingNote: resolved.closingNote,
                      }
                    : item,
                ),
              }
            : current,
        );
        setSelection((current) => {
          if (!current.has(id)) return current;
          const next = new Set(current);
          next.delete(id);
          return next;
        });
        toast.success('Alert marked as resolved.');
      } catch {
        toast.error('Could not resolve alert.');
      } finally {
        setPendingResolveId(null);
      }
    },
    [data, pendingResolveId],
  );

  const handleReopen = useCallback(
    async (id: string) => {
      if (!data || reopenPendingId) return;
      const row = data.items.find((r) => r.id === id);
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
        setData({
          ...data,
          items: data.items.map((item) =>
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
    [data, reopenPendingId],
  );

  // False-positive gesture state + handlers. Two sources of dialog
  // open (per-row button on the table/cards + the bulk action bar
  // CTA), one target label that the dialog reads — the dialog itself
  // is presentational and never owns the open state.
  //   - `fpDialogOpen` — controlled by the page; both the per-row
  //     gesture and the bulk CTA flip it to true via
  //     `openFalsePositiveDialog(target)`.
  //   - `fpDialogTarget` — `'per-row:<id>' | 'bulk'`, drives the
  //     dialog's `targetLabel` so the row-vs-bulk distinction is
  //     visible to the operator.
  //   - `fpSubmitting` — true while a POST is in flight; disables
  //     both the dialog's submit and cancel so a stale double-click
  //     can't drop the dialog mid-flight.
  //   - `fpSubmittingFor` — the alert id currently being POSTed to
  //     (only set in the single-row path). Disables the per-row
  //     button so a stale click can't fire a second fan-out for the
  //     same row.
  const [fpDialogOpen, setFpDialogOpen] = useState(false);
  const [fpDialogTarget, setFpDialogTarget] = useState<string | null>(null);
  const [fpSubmitting, setFpSubmitting] = useState(false);
  const [fpSubmittingFor, setFpSubmittingFor] = useState<string | null>(null);

  const openFalsePositiveDialogSingle = useCallback((id: string) => {
    setFpDialogTarget(`per-row:${id}`);
    setFpDialogOpen(true);
  }, []);

  const openFalsePositiveDialogBulk = useCallback(() => {
    setFpDialogTarget('bulk');
    setFpDialogOpen(true);
  }, []);

  // Single-row POST path — invoked when the dialog's submit button
  // is clicked with a per-row target. Mirrors the handleReopen
  // posture: gate on data + a pending-id set, POST with optimistic
  // flip on success, fall through to a 500 on network/parse error.
  // The route returns the `falsePositiveReason` we just wrote so
  // the optimistic flip stamps the same reason onto the chip
  // subtitle without a second read.
  const submitSingleFalsePositive = useCallback(
    async (id: string, reason: string) => {
      if (!data || fpSubmitting) return;
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
        setData({
          ...data,
          items: data.items.map((item) =>
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
    [data, fpSubmitting],
  );

  // Bulk POST path — same as the single path, but fans out against
  // N selected rows with one shared reason. The helper
  // (runBulkFalsePositive) handles pre-filter + allSettled + the
  // optimistic flip; the page owns the React state wiring
  // (pending set, outcome map, optimistic flip, selection clear,
  // toast). Dialog target label says "N selected" so the operator
  // knows the reason will apply to the whole working set.
  const submitBulkFalsePositive = useCallback(
    async (reason: string) => {
      if (!data || pendingBulkIds.size > 0 || selection.size === 0) return;
      // Pre-compute the candidate id set so the bar can flip
      // `pending` at submit-time. The helper also pre-filters
      // internally — this duplicate filter only feeds the loading-
      // state gate.
      const candidateIds = data.items
        .filter((item) => selection.has(item.id) && item.status !== 'false_positive')
        .map((item) => item.id);
      if (candidateIds.length === 0) {
        // Working set was entirely already-FP — silent no-op. Don't
        // churn the bar's indicator strip or fire a toast.
        setFpDialogOpen(false);
        return;
      }
      setPendingBulkIds(new Set(candidateIds));
      setBulkResults(new Map());
      setFpSubmitting(true);
      const result = await runBulkFalsePositive({
        items: data.items,
        selection,
        reason,
        fetchImpl: fetch,
      });
      setBulkResults(result.outcomes);
      setPendingBulkIds(new Set());
      setFpSubmitting(false);
      setFpDialogOpen(false);
      if (result.allOk) {
        setData({ ...data, items: result.items });
        setSelection(new Set());
        toast.success(
          `${result.okCount} ${result.okCount === 1 ? 'alert' : 'alerts'} marked as false positive.`,
        );
      } else {
        const failed = result.candidates.length - result.okCount;
        toast.error(`${failed} of ${result.candidates.length} failed to mark as false positive.`);
      }
    },
    [data, pendingBulkIds, selection],
  );

  // Dialog submit dispatcher — the dialog itself is presentational,
  // so the page owns the open-state POST. The target string
  // discriminates the two call sites so the dialog's onSubmit fires
  // the right per-row vs bulk path.
  const handleFalsePositiveSubmit = useCallback(
    async (reason: string) => {
      if (!fpDialogTarget) return;
      if (fpDialogTarget === 'bulk') {
        await submitBulkFalsePositive(reason);
        return;
      }
      if (fpDialogTarget.startsWith('per-row:')) {
        const id = fpDialogTarget.slice('per-row:'.length);
        await submitSingleFalsePositive(id, reason);
        setFpDialogOpen(false);
      }
    },
    [fpDialogTarget, submitBulkFalsePositive, submitSingleFalsePositive],
  );

  const fpDialogTargetLabel = useMemo(() => {
    if (fpDialogTarget == null) return '';
    if (fpDialogTarget === 'bulk') {
      return `${selection.size} selected ${selection.size === 1 ? 'alert' : 'alerts'}`;
    }
    if (fpDialogTarget.startsWith('per-row:')) {
      return fpDialogTarget.slice('per-row:'.length).trim() || 'this alert';
    }
    return 'this alert';
  }, [fpDialogTarget, selection.size]);

  // Reset dialog state when the selection drops to 0 — prevents the
  // bulk CTA from re-opening with a stale "N selected" label after
  // a clear.
  useEffect(() => {
    if (selection.size === 0 && fpDialogTarget === 'bulk') {
      setFpDialogOpen(false);
    }
  }, [selection.size, fpDialogTarget]);

  // Selection-mutation handlers. Page-level so a row-toggle on the
  // mobile card surfaces the same click semantics as the desktop
  // table's checkbox. Single id pass-through keeps the API minimal
  // while still letting the URL writer + viewKey effect handle all
  // the bookkeeping (URL round-trip + reset on view-change).
  const handleRowToggle = useCallback((id: string) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleToggleAllVisible = useCallback((nextIds: string[]) => {
    setSelection((prev) => {
      if (prev.size === nextIds.length && nextIds.every((id) => prev.has(id))) {
        return new Set();
      }
      return new Set(nextIds);
    });
  }, []);

  // Bulk resolve gesture — small note-prompt dialog collects an
  // OPTIONAL shared note (paragraph-capped at 500 chars) before firing
  // the fan-out. The dialog mirrors the reopen dialog's posture but
  // with the named-arg renamed from `reason` to `note` (the /resolve
  // route stamps `Alert.closingNote` from this value), and the helper
  // trims the blank branch to `{}` so the route stamps NULL on every
  // row. The helper does the parallel fan-out + parsed-envelope
  // guard + the per-row outcome map + the optimistic flip; the page
  // island wraps it with React state wiring, so a fan-out-level test
  // tree-level mount is sufficient to pin the contract.
  //
  // Two open sources, one target label:
  //   - `resolveDialogOpen` — controlled by the page; the bar's bulk
  //     CTA flips it open via `openResolveDialogBulk`.
  //   - `resolveSubmitting` — true while the fan-out is in flight so
  //     the dialog's submit + cancel are disabled mid-stamp.
  const [resolveDialogOpen, setResolveDialogOpen] = useState(false);
  const [resolveSubmitting, setResolveSubmitting] = useState(false);

  const openResolveDialogBulk = useCallback(() => {
    setResolveDialogOpen(true);
  }, []);

  // Reset dialog state when the selection drops to 0 — prevents the
  // bulk CTA from re-opening with a stale "N selected" label after
  // a clear. Mirrors the reopen + FP dialog effects above.
  useEffect(() => {
    if (selection.size === 0) {
      setResolveDialogOpen(false);
    }
  }, [selection.size]);

  // Bulk resolve handler — mirrors the reopen handler's posture:
  // pre-filter to non-resolved rows, fan out against /resolve, flip
  // only the targeted ids to 'resolved' on all-OK, drop selection +
  // close dialog so the URL never carries stale ids pointing at
  // now-resolved rows. The helper carries the parallel fan-out +
  // parsed-envelope guard + the per-row outcome map + the optimistic
  // flip; the page island wraps it with React state wiring.
  const submitBulkResolve = useCallback(
    async (note: string) => {
      if (!data || pendingBulkIds.size > 0 || selection.size === 0) return;
      // Pre-compute the candidate id set so the bar can flip
      // `pending` immediately at submit-time. The helper also pre-
      // filters internally — this duplicate filter only feeds the
      // loading-state gate.
      const candidateIds = data.items
        .filter((item) => selection.has(item.id) && item.status !== 'resolved')
        .map((item) => item.id);
      if (candidateIds.length === 0) {
        // Working set was made entirely of already-resolved rows —
        // silent no-op. Don't churn the bar's indicator strip or
        // fire a misleading toast; drop the dialog.
        setResolveDialogOpen(false);
        return;
      }
      setPendingBulkIds(new Set(candidateIds));
      setBulkResults(new Map());
      setResolveSubmitting(true);
      const result = await runBulkResolve({
        items: data.items,
        selection,
        note,
        fetchImpl: fetch,
      });
      setBulkResults(result.outcomes);
      setPendingBulkIds(new Set());
      setResolveSubmitting(false);
      setResolveDialogOpen(false);
      if (result.allOk) {
        setData({ ...data, items: result.items });
        setSelection(new Set());
        toast.success(`${result.okCount} ${result.okCount === 1 ? 'alert' : 'alerts'} resolved.`);
      } else {
        const failed = result.candidates.length - result.okCount;
        toast.error(`${failed} of ${result.candidates.length} failed to resolve.`);
      }
    },
    [data, pendingBulkIds, selection],
  );

  // Bulk resolve-batch handler — sister to `submitBulkResolve` but
  // mirrors the popover-driven /resolve-batch route. Differs in two
  // ways:
  //   1. No dialog — the bar's new "Resolve selected" Radix popover
  //      owns the note input + open state. The page just receives
  //      the (trimmed) note via the `onResolveSelected` callback and
  //      fires a single POST against the new endpoint.
  //   2. The candidate pre-filter drops both already-`resolved`
  //      AND future-snoozed ids (mirroring the route's scope +
  //      snooze-gate branches) — same posture the bulk-resolve
  //      helper takes, and the route's idempotent posture matches.
  // The popover resets its local note state on every open so the
  // handler always reads the freshly-typed string.
  const submitBulkResolveBatch = useCallback(
    async (note: string) => {
      if (!data || pendingBulkIds.size > 0 || selection.size === 0) return;
      // Pre-compute the candidate id set so the bar can flip
      // `pending` immediately at submit-time. The helper also pre-
      // filters internally (drops already-resolved + future-snoozed)
      // — this duplicate filter only feeds the loading-state gate
      // so the candidate-id pre-set is non-empty before any POST
      // fires.
      const activeNow = Date.now();
      const candidateIds = data.items
        .filter((item) => {
          if (!selection.has(item.id)) return false;
          if (item.status === 'resolved') return false;
          if (item.snoozedUntil) {
            const t = Date.parse(item.snoozedUntil);
            if (!Number.isNaN(t) && t > activeNow) return false;
          }
          return true;
        })
        .map((item) => item.id);
      if (candidateIds.length === 0) {
        // Working set was made entirely of already-resolved /
        // future-snoozed rows — silent no-op. Don't churn the
        // bar's indicator strip or fire a misleading toast.
        return;
      }
      setPendingBulkIds(new Set(candidateIds));
      setBulkResults(new Map());
      const result = await runBulkResolveBatch({
        items: data.items,
        selection,
        note,
        fetchImpl: fetch,
      });
      setBulkResults(result.outcomes);
      setPendingBulkIds(new Set());
      if (result.allOk) {
        setData({ ...data, items: result.items });
        setSelection(new Set());
        toast.success(`${result.okCount} ${result.okCount === 1 ? 'alert' : 'alerts'} resolved.`);
      } else {
        const failed = result.candidates.length - result.okCount;
        toast.error(`${failed} of ${result.candidates.length} failed to resolve.`);
      }
    },
    [data, pendingBulkIds, selection],
  );

  // Bulk-reopen gesture: a small reason-prompt dialog collects an
  // optional shared reason (paragraph-capped at 500 chars) before
  // firing the fan-out. The dialog mirrors the FP dialog's posture
  // but with the submit gate loosened — an empty reason is valid
  // on the reopen path (parity with the single-row resolve
  // composer on the detail card), and the helper trims the blank
  // branch to `{}` so the route stamps NULL.
  //
  // Two open sources, one target label:
  //   - `reopenDialogOpen` — controlled by the page; the bar's
  //     bulk CTA flips it open via `openReopenDialogBulk`.
  //   - `reopenDialogTarget` — `'bulk'` for v1 (single-row
  //     reopens are inline on the detail card; the per-row
  //     Reopen button on the table/card POSTs the bare `{}`
  //     body for backwards compat).
  //   - `reopenSubmitting` — true while the fan-out is in flight
  //     so the dialog's submit + cancel are disabled mid-stamp.
  const [reopenDialogOpen, setReopenDialogOpen] = useState(false);
  const [reopenSubmitting, setReopenSubmitting] = useState(false);

  const openReopenDialogBulk = useCallback(() => {
    setReopenDialogOpen(true);
  }, []);

  // Bulk reopen handler — inverse of the resolve handler, with three
  // deltas:
  //   1. The fan-out pre-filters targets to `status === 'resolved'`
  //      so already-open ids are silently skipped — mirrors the
  //      route's idempotent-already-open branch so a stale click
  //      never churns statusChangedAt.
  //   2. POSTs an OPTIONAL `{reason}` body to each fan-out target.
  //      Blank/whitespace-only reasons collapse to `{}` so the
  //      route stamps NULL on the reopen trio's reason column.
  //   3. Optimistic flip on all-OK stamps ONLY the targeted-resolved
  //      rows to 'open'; already-open rows are untouched. Selection
  //      drops on all-OK so the URL doesn't carry stale ids pointing
  //      at now-open rows (matching the contract that a chip click
  //      + a reopen would otherwise cross-clean).
  const submitBulkReopen = useCallback(
    async (reason: string) => {
      if (!data || pendingBulkIds.size > 0 || selection.size === 0) return;
      // Pre-compute the candidate id set so the bar can flip
      // `pending` immediately at submit-time (matches the FP
      // helper's posture).
      const candidateIds = data.items
        .filter((item) => selection.has(item.id) && item.status === 'resolved')
        .map((item) => item.id);
      if (candidateIds.length === 0) {
        // Working set was made entirely of already-open rows —
        // silent no-op. Don't churn the bar's indicator strip or
        // fire a misleading toast; drop the dialog.
        setReopenDialogOpen(false);
        return;
      }
      setPendingBulkIds(new Set(candidateIds));
      setBulkResults(new Map());
      setReopenSubmitting(true);
      const result = await runBulkReopen({
        items: data.items,
        selection,
        reason,
        fetchImpl: fetch,
      });
      setBulkResults(result.outcomes);
      setPendingBulkIds(new Set());
      setReopenSubmitting(false);
      setReopenDialogOpen(false);
      if (result.allOk) {
        setData({ ...data, items: result.items });
        setSelection(new Set());
        toast.success(`${result.okCount} ${result.okCount === 1 ? 'alert' : 'alerts'} reopened.`);
      } else {
        const failed = result.candidates.length - result.okCount;
        toast.error(`${failed} of ${result.candidates.length} failed to reopen.`);
      }
    },
    [data, pendingBulkIds, selection],
  );

  // Bulk-snooze handler — see runBulkSnooze for the helper's contract.
  // Sister to the other three bulk handlers but with three deltas:
  //   1. No status / snooze-onset pre-filter — every selected row is
  //      a candidate; re-applying snooze refreshes the window
  //      (idempotent on prior snoozedUntil). The pending-IDs set is
  //      stamped with every selected id so the bar's indicator strip
  //      tracks each in-flight row.
  //   2. Optimistic flip stamps ONLY snoozedUntil on every targeted
  //      id on all-OK; selection drops so the URL no longer carries
  //      `?selected=` matching the existing trio's contract that the
  //      bar remounts after a chip/clear.
  //   3. ONE callback — `target: BulkSnoozeTarget` (a discriminated
  //      union mirroring `AlertBulkSnoozeBody`'s arms). The bar's
  //      popover emits `{ kind: 'duration', duration }` for the four
  //      preset button picks (1d / 3d / 7d / 30d — the literal enum
  //      that flows through `runBulkSnooze`, the route's WINDOW_MS
  //      table, and the optimistic-flip stamp), and
  //      `{ kind: 'until', until: <ISO> }` for the custom-date Apply
  //      button. A discriminated guard inside the handler picks the
  //      right toast copy without losing the helper-target shape.
  //      The single source of truth lives in `@/lib/contracts/alerts.ts`
  //      so any literal widening cascades through the route, the
  //      helper, AND this page-island callback as one.
  // On partial failure: keep selection so the operator can re-apply;
  // surface a toast with the failure count.
  const submitBulkSnooze = useCallback(
    async (
      target:
        | { kind: 'duration'; duration: '1d' | '3d' | '7d' | '30d' }
        | { kind: 'until'; until: string },
    ) => {
      if (!data || pendingBulkIds.size > 0 || selection.size === 0) return;
      const candidateIds = data.items.filter((item) => selection.has(item.id)).map((i) => i.id);
      if (candidateIds.length === 0) return;
      setPendingBulkIds(new Set(candidateIds));
      setBulkResults(new Map());
      const result = await runBulkSnooze({
        items: data.items,
        selection,
        target,
        fetchImpl: fetch,
      });
      setBulkResults(result.outcomes);
      setPendingBulkIds(new Set());
      if (result.allOk) {
        setData({ ...data, items: result.items });
        setSelection(new Set());
        const okLabel = `${result.okCount} ${result.okCount === 1 ? 'alert' : 'alerts'}`;
        if (target.kind === 'duration') {
          toast.success(`${okLabel} snoozed for ${target.duration}.`);
        } else {
          // The bar's `<input type="date">` emits a `YYYY-MM-DD` —
          // localise via `toLocaleDateString` so the toast reads in
          // the operator's locale, not as raw ISO.
          const formatted = new Date(`${target.until}T00:00:00`).toLocaleDateString();
          toast.success(`${okLabel} snoozed until ${formatted}.`);
        }
      } else {
        const failed = result.candidates.length - result.okCount;
        toast.error(`${failed} of ${result.candidates.length} failed to snooze.`);
      }
    },
    [data, pendingBulkIds, selection],
  );

  // Bulk-remediate handler. Sister to submitBulkSnooze but with two
  // deltas driven by the new bulk route:
  //   1. The candidate pre-filter drops already-remediated ids
  //      (`item.remediatedAt === null`) so a re-stamp on a stamped
  //      row never reaches the wire. The bulk route's idempotent
  //      branch preserves the original stamp anyway, but the helper
  //      pre-filter saves the round trip + saves a misleading
  //      'already stamped' toast.
  //   2. `callerEmail` flows through the imperative `callerEmailRef`
  //      so the useCallback closure reads the LATEST session email
  //      (NOT the value captured at the closure's mount time). The
  //      optimistic flip stamps `remediatedByEmail` onto every
  //      targeted row — when the email is unknown the flip degrades
  //      to "stamp remediation time only" (still a row-level
  //      success); the server stamp is the authoritative source.
  const submitBulkRemediate = useCallback(async () => {
    if (!data || pendingBulkIds.size > 0 || selection.size === 0) return;
    const candidateIds = data.items
      .filter((item) => selection.has(item.id) && item.remediatedAt === null)
      .map((i) => i.id);
    if (candidateIds.length === 0) return;
    setPendingBulkIds(new Set(candidateIds));
    setBulkResults(new Map());
    const result = await runBulkRemediate({
      items: data.items,
      selection,
      callerEmail: callerEmailRef.current,
      fetchImpl: fetch,
    });
    setBulkResults(result.outcomes);
    setPendingBulkIds(new Set());
    if (result.allOk) {
      setData({ ...data, items: result.items });
      setSelection(new Set());
      toast.success(`${result.okCount} ${result.okCount === 1 ? 'alert' : 'alerts'} remediated.`);
    } else {
      const failed = result.candidates.length - result.okCount;
      toast.error(`${failed} of ${result.candidates.length} failed to mark remediated.`);
    }
  }, [data, pendingBulkIds, selection]);

  // Bulk "Take ownership" handler. Sister to submitBulkRemediate
  // with three deltas driven by the new bulk route:
  //   1. Already-owned rows are SILENTLY DROPPED from the
  //      candidate set (`item.ownerId !== callerWorkspaceMemberId
  //      Ref.current`) so a typical bulk-take selection never
  //      produces conflicts at the wire. The route surfaces a
  //      stale post-mount reassignment through the `conflicts[]`
  //      envelope arm, which the helper still paints 'ok' so
  //      `allOk = true` once every candidate id POST'd.
  //   2. `callerWorkspaceMemberId` + `callerName` flow through
  //      the imperative refs so the useCallback closure reads the
  //      latest values (NOT the values captured at the closure's
  //      mount time). On a null `callerWorkspaceMemberIdRef
  //      .current` short-circuit silently — the caller is not an
  //      active team member, and a fetch the route would 404 is
  //      worse than a quiet no-op. (Idempotent re-binding during
  //      the optimistic flip: `ownerId` is stamped to the
  //      server-resolved callerWorkspaceMemberId, `ownerName`
  //      mirrors `callerName` so the chip stack stays consistent
  //      without a follow-up fetch.)
  //   3. Success toast composes from `okCount` AND
  //      `conflictCount`: "N taken. M already owned." when a
  //      stale race surfaces conflicts at fetch time; bare
  //      "N taken." on a clean run.
  const submitBulkTakeOwnership = useCallback(async () => {
    if (!data || pendingBulkIds.size > 0 || selection.size === 0) return;
    if (callerWorkspaceMemberIdRef.current === null) return;
    const candidateIds = data.items
      .filter(
        (item) => selection.has(item.id) && item.ownerId !== callerWorkspaceMemberIdRef.current,
      )
      .map((i) => i.id);
    if (candidateIds.length === 0) return;
    setPendingBulkIds(new Set(candidateIds));
    setBulkResults(new Map());
    const result = await runBulkTakeOwnership({
      items: data.items,
      selection,
      callerWorkspaceMemberId: callerWorkspaceMemberIdRef.current,
      callerName: callerNameRef.current,
      fetchImpl: fetch,
    });
    setBulkResults(result.outcomes);
    setPendingBulkIds(new Set());
    if (result.allOk) {
      setData({ ...data, items: result.items });
      setSelection(new Set());
      const plural = result.okCount === 1 ? 'alert' : 'alerts';
      if (result.conflictCount > 0) {
        toast.success(
          `${result.okCount - result.conflictCount} ${plural} taken. ${result.conflictCount} already owned.`,
        );
      } else {
        toast.success(`${result.okCount} ${plural} taken.`);
      }
    } else {
      const failed = result.candidates.length - result.okCount;
      toast.error(`${failed} of ${result.candidates.length} failed to take ownership.`);
    }
  }, [data, pendingBulkIds, selection]);

  // Bulk "Assign owner" handler — sister to `submitBulkTakeOwnership`
  // with two confirmed deltas driven by the new bulk endpoint:
  //   1. The handler receives a bare `ownerId` from the bar's
  //      popover — the page-side handler resolves the matching
  //      `ownerName` from the already-fetched `members` roster
  //      (the same roster the popover reads). A roster with no
  //      matching id (a stale post-mount race) falls back to
  //      `null`, matching the route's `User.name ?? null`
  //      posture.
  //   2. EVERY selected row is a candidate — no
  //      already-owned / status pre-filter. The bulk route's
  //      idempotent-refresh contract means re-applying the
  //      same FK is a no-op success; re-stamping a different FK
  //      is the explicit transfer. The helper stamps BOTH
  //      `ownerId` AND `ownerName` on every targeted id on
  //      all-OK.
  //
  // Success toast reads `"N alerts assigned to <name>."` —
  // composes from `okCount` + the resolved `ownerName` so the
  // operator sees the picked colleague in the toast without
  // checking the row list. On partial failure: keep selection
  // so the operator can re-apply; surface a toast with the
  // failure count (mirrors the snooze / resolve / take-
  // ownership partial-failure toasts).
  const submitBulkAssignOwner = useCallback(
    async (ownerId: string) => {
      if (!data || pendingBulkIds.size > 0 || selection.size === 0) return;
      const candidateIds = data.items.filter((item) => selection.has(item.id)).map((i) => i.id);
      if (candidateIds.length === 0) return;
      const picked = members.find((m) => m.id === ownerId);
      const ownerName = picked?.name ?? null;
      setPendingBulkIds(new Set(candidateIds));
      setBulkResults(new Map());
      const result = await runBulkAssignOwner({
        items: data.items,
        selection,
        ownerId,
        ownerName,
        fetchImpl: fetch,
      });
      setBulkResults(result.outcomes);
      setPendingBulkIds(new Set());
      if (result.allOk) {
        setData({ ...data, items: result.items });
        setSelection(new Set());
        const plural = result.okCount === 1 ? 'alert' : 'alerts';
        const label = ownerName ?? ownerId;
        toast.success(`${result.okCount} ${plural} assigned to ${label}.`);
      } else {
        const failed = result.candidates.length - result.okCount;
        toast.error(`${failed} of ${result.candidates.length} failed to assign owner.`);
      }
    },
    [data, pendingBulkIds, selection, members],
  );

  const handleClearSelection = useCallback(() => {
    setSelection(new Set());
    setBulkResults(new Map());
    setPendingBulkIds(new Set());
  }, []);

  // Derived header-checkbox state — drives `data-state` so the
  // indeterminate styling on the primitive fires when a partial
  // selection is in flight. `selectionState` is "all" / "some" /
  // "none" — the literal string passed to `checked` so Radix picks the
  // right internal state.
  const visibleIds = useMemo(() => (data ? data.items.map((i) => i.id) : []), [data]);
  const allVisibleSelected =
    visibleIds.length > 0 &&
    selection.size === visibleIds.length &&
    visibleIds.every((id) => selection.has(id));
  const someVisibleSelected = !allVisibleSelected && visibleIds.some((id) => selection.has(id));
  const headerChecked: boolean | 'indeterminate' = allVisibleSelected
    ? true
    : someVisibleSelected
      ? 'indeterminate'
      : false;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium text-muted-foreground">
          <Bell className="mr-1.5 inline size-4 align-[-0.18em] text-brand-500" />
          Alerts
        </p>
        <h1 className="font-display text-h1 tracking-tight text-foreground">Team alerts</h1>
        <p className="max-w-prose text-body-lg text-muted-foreground">
          CISA Known Exploited Vulnerabilities (KEV) transitions and fresh VulnCheck sightings for
          findings owned by your team. Switch the sort dropdown to reorder; Last activity is the
          default and matches the CSV export download 1:1.
        </p>
      </header>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load alerts</AlertTitle>
          <AlertDescription className="font-mono text-caption">{error}</AlertDescription>
        </Alert>
      ) : null}

      {q ? <AlertsSearchQueryBadge value={q} /> : null}

      <section
        aria-label="Search alerts"
        className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center"
      >
        <AlertsTextQueryInput initialValue={initialSearchParams.get('q') ?? ''} />
        <AlertsHostnameSearchInput initialValue={initialSearchParams.get('hostname') ?? ''} />
      </section>

      <AlertsSeverityChipRow
        value={severity}
        onChange={setSeverity}
        options={data?.severityOptions ?? []}
      />
      <AlertsResolutionChipRow value={resolution ?? 'unresolved'} onChange={setResolution} />
      <AlertsStatusChipRow
        value={openOnly ? 'open' : status}
        includeOpen
        onChange={(next) => {
          setStatus(next === 'open' ? null : next);
          setOpenOnly(next === 'open');
          setResolvedOnly(false);
        }}
      />
      <AlertsSourceChipRow value={triggeredBy} onChange={setTriggeredBy} />
      <AlertsAssetChipRow value={asset} onChange={setAsset} options={assetOptions} maxItems={10} />
      <AlertsSinceChipRow value={since} onChange={setSince} />
      <AlertsDateRangeChipRow value={dateRangePreset} onChange={handleDateRangePresetChange} />
      <AlertsHighRiskAssetsChipRow value={highRiskAssets} onChange={setHighRiskAssets} />
      {/* Status, ownership, remediation and snooze filters compose in the URL. */}
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
          // Snoozed composes with owner, status, severity, source,
          // asset, and the text/date inputs; this toggles only
          // the snoozed filter.
          setSnoozedOnly(true);
        }}
      />
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

      <section
        aria-label="Filter alerts by date range, sort, and export"
        className="flex w-full min-w-0 flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:justify-between"
      >
        <div className="flex w-full min-w-0 flex-1 flex-wrap items-center gap-2 md:w-auto">
          <AlertsDateRangeInput
            key={dateRangePreset ?? 'custom'}
            initialFrom={initialSearchParams.get('from') ?? ''}
            initialTo={initialSearchParams.get('to') ?? ''}
          />
          <AlertsSortSelect value={sort} onChange={setSort} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SendSnoozeDigestButton />
          {/* Export follows the active URL filters and stays disabled until
              the first scoped alert list response has loaded. */}
          <AlertsExportButton search={effectiveQs} disabled={!data} />
        </div>
      </section>

      <AlertsCountBadges counts={data?.counts ?? null} />

      {/* Bulk action bar — only mounts when the working set is non-
          empty AND the first /api/alerts envelope has resolved
          (otherwise the selection has no real rows to resolve against
          and the bar's `Mark selected resolved` CTA would be a
          no-op). Sticky at the top of the band so it pins under the
          dashboard topbar when the user scrolls a long table. The
          FP CTA opens the reason dialog; one reason applies to N
          selected rows. The Snooze CTA is a Radix Popover that
          fans out into four option buttons (1d / 3d / 7d / 30d) —
          each option fires the single `onSnooze` callback with the
          matching `SnoozeDuration` literal, the popover closes before
          the page's fan-out starts so a stale re-click can't queue a
          second fan-out, and the bar's `pending` gate disables the
          trigger while a fan-out is in flight. */}
      {data && selection.size > 0 ? (
        <AlertsBulkActionBar
          selectionCount={selection.size}
          results={bulkResults}
          pending={pendingBulkIds.size > 0}
          onResolve={openResolveDialogBulk}
          onReopenSelected={openReopenDialogBulk}
          onMarkFalsePositive={openFalsePositiveDialogBulk}
          onSnooze={(duration) => submitBulkSnooze({ kind: 'duration', duration })}
          onSnoozeUntil={(until) => submitBulkSnooze({ kind: 'until', until })}
          onRemediate={submitBulkRemediate}
          onTakeOwnership={submitBulkTakeOwnership}
          onAssignOwner={submitBulkAssignOwner}
          onResolveSelected={(note) => submitBulkResolveBatch(note)}
          members={members}
          onClear={handleClearSelection}
        />
      ) : null}

      {!data && !error ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[3rem]">
                <span className="sr-only">Select all</span>
              </TableHead>
              <TableHead className="w-[14rem]">Severity &amp; status</TableHead>
              <TableHead className="w-[10rem]">CVE ID</TableHead>
              <TableHead>Asset</TableHead>
              <TableHead className="w-[12rem]">Source</TableHead>
              <TableHead className="w-[12rem]">Triggered by</TableHead>
              <TableHead className="w-[14rem]">Timestamp</TableHead>
              <TableHead className="w-[10rem]">Last activity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {SKELETON_ROW_KEYS.map((rowKey) => (
              <TableRow key={rowKey}>
                <TableCell>
                  <Skeleton className="h-4 w-4" />
                </TableCell>
                <TableCell>
                  <div className="space-y-2">
                    <Skeleton className="h-5 w-16" />
                    <Skeleton className="h-9 w-36" />
                  </div>
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-24" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-40" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-5 w-20" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-5 w-24" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-32" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-32" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}

      {data ? (
        <div className="flex flex-col gap-2">
          <p className="text-caption text-muted-foreground">
            {data.total} {data.total === 1 ? 'alert' : 'alerts'}
          </p>
          <div className="md:hidden">
            <AlertsListCards
              items={data.items}
              detailQueryString={detailQueryString}
              emptyStateMessage={emptyStateMessage}
              pendingResolveId={pendingResolveId}
              onResolve={handleResolve}
              pendingReopenId={reopenPendingId}
              onReopened={handleReopen}
              pendingFalsePositiveId={fpSubmittingFor}
              onFalsePositive={openFalsePositiveDialogSingle}
              onStatusSaved={handleStatusSaved}
              selectedIds={selection}
              onToggle={handleRowToggle}
            />
          </div>
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[3rem]">
                    <Checkbox
                      checked={headerChecked}
                      onCheckedChange={() => handleToggleAllVisible(visibleIds)}
                      aria-label="Select all visible alerts"
                    />
                  </TableHead>
                  <TableHead className="w-[14rem]">Severity &amp; status</TableHead>
                  <TableHead className="w-[10rem]">CVE ID</TableHead>
                  <TableHead>Asset</TableHead>
                  <TableHead className="w-[14rem]">Alert age</TableHead>
                  <TableHead className="w-[12rem]">Source</TableHead>
                  <TableHead className="w-[12rem]">Triggered by</TableHead>
                  <TableHead
                    className="w-[10rem]"
                    // `aria-sort` is the columnheader-authorized
                    // sortable-header affordance. Lifts the
                    // button's `onClick` state to something a
                    // screen reader can announce. Reads the
                    // new key shape: `'ascending'` for
                    // `lastActivity:asc`, `'descending'` for
                    // `lastActivity` (the default), and `'none'`
                    // for every other sort key that happens to
                    // flow through this column's button gesture.
                    aria-sort={
                      sort === 'lastActivity'
                        ? 'descending'
                        : sort === 'lastActivity:asc'
                          ? 'ascending'
                          : 'none'
                    }
                  >
                    <button
                      type="button"
                      // Toggle the page-level sort state across the
                      // 2-way cycle `lastActivity` ↔
                      // `lastActivity:asc`. Clicking the column
                      // header is the inline direction affordance;
                      // the dropdown remains the canonical
                      // surface for switching the underlying
                      // sort key (Last activity / Created /
                      // Severity). The single button keeps the
                      // minimal gesture the brief pins — the
                      // dropdown exposes both directions for the
                      // Last activity + Created arms so the
                      // affordance is reachable without using the
                      // header toggle.
                      onClick={() =>
                        setSort((prev) =>
                          prev === 'lastActivity' ? 'lastActivity:asc' : 'lastActivity',
                        )
                      }
                      className="inline-flex items-center gap-1.5 rounded font-medium text-foreground transition-colors hover:text-brand-600"
                    >
                      Last activity
                      {sort === 'lastActivity' ? (
                        <span aria-hidden className="font-mono text-caption text-brand-600">
                          ↓
                        </span>
                      ) : sort === 'lastActivity:asc' ? (
                        <span aria-hidden className="font-mono text-caption text-brand-600">
                          ↑
                        </span>
                      ) : null}
                    </button>
                  </TableHead>
                  <TableHead className="w-[7rem] text-right">Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center text-body text-muted-foreground">
                      {emptyStateMessage}
                    </TableCell>
                  </TableRow>
                ) : (
                  data.items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <Checkbox
                          checked={selection.has(item.id)}
                          onCheckedChange={() => handleRowToggle(item.id)}
                          aria-label={`Select alert ${item.id}`}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge
                              variant={severityVariant(item.severity)}
                              className="font-mono uppercase tracking-wider"
                            >
                              {item.severity ?? 'unknown'}
                            </Badge>
                            {item.snoozedUntil ? (
                              <Badge
                                variant="outline"
                                className="font-mono text-caption"
                                title={`Snoozed until ${new Date(item.snoozedUntil).toLocaleString()}`}
                              >
                                Snoozed until {new Date(item.snoozedUntil).toLocaleString()}
                              </Badge>
                            ) : null}
                            {item.trending ? <TrendingBadge cveId={item.cveId} /> : null}
                            {item.commentCount && item.commentCount > 0 ? (
                              <CommentsCountBadge
                                count={item.commentCount}
                                alertId={item.id}
                                detailQueryString={detailQueryString}
                              />
                            ) : null}
                            {item.remediatedAt ? (
                              <Badge
                                variant="outline"
                                className="font-mono text-caption text-brand-600"
                                title={`Remediated at ${new Date(item.remediatedAt).toLocaleString()}`}
                              >
                                Remediated
                              </Badge>
                            ) : null}
                            {item.status === 'resolved' ? (
                              <Badge
                                variant="secondary"
                                className="font-mono text-caption"
                                data-testid="alert-resolved-badge"
                              >
                                Resolved
                              </Badge>
                            ) : null}
                          </div>
                          <AlertsListStatus item={item} onSaved={handleStatusSaved} />
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-caption">
                        {item.cveId ? (
                          <a
                            href={`https://nvd.nist.gov/vuln/detail/${item.cveId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline-offset-2 hover:underline"
                          >
                            {item.cveId}
                          </a>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-caption">
                        {item.asset.host ? (
                          <span className="inline-flex flex-col items-start gap-0.5">
                            <span className="inline-flex items-baseline gap-1">
                              {item.asset.detailHref ? (
                                <Button asChild variant="link" size="sm" className="px-0">
                                  <Link
                                    href={item.asset.detailHref}
                                    className="font-mono text-caption"
                                  >
                                    {item.asset.host}
                                  </Link>
                                </Button>
                              ) : (
                                <span className="font-mono text-caption">{item.asset.host}</span>
                              )}
                              <span className="text-muted-foreground">
                                :{item.asset.port}/{item.asset.protocol}
                              </span>
                            </span>
                            {item.asset.riskScore != null &&
                            Number.isFinite(item.asset.riskScore) ? (
                              <span className="text-muted-foreground">
                                Risk {item.asset.riskScore.toFixed(2)} /10
                              </span>
                            ) : null}
                          </span>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="flex flex-col gap-0.5">
                          <AlertAge
                            createdAt={item.createdAt}
                            now={now}
                            className="font-mono text-caption"
                          />
                          <span className="text-caption text-muted-foreground">
                            {formatAlertCreatedAt(item.createdAt) ?? 'Unknown'}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={sourceVariant(item.source)}
                          className="font-mono uppercase tracking-wider"
                        >
                          {item.source === 'kev'
                            ? 'KEV'
                            : item.source === 'manual'
                              ? 'Manual'
                              : 'VulnCheck'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-mono text-caption">
                          Triggered by {scanSourceLabels[item.triggeredBy ?? 'manual']}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {item.lastActivityAt ? (
                          <span
                            className="font-mono text-caption text-muted-foreground"
                            title={item.lastActivityAt}
                          >
                            {formatRelative(item.lastActivityAt, now)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="w-[7rem] text-right">
                        <div className="flex flex-col items-end gap-1">
                          <div className="flex flex-wrap items-center justify-end gap-2">
                            <Button asChild variant="link" size="sm" className="px-0">
                              <Link href={buildAlertDetailHref(item.id, detailQueryString)}>
                                View details
                              </Link>
                            </Button>
                            {item.status !== 'resolved' && item.status !== 'false_positive' ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => void handleResolve(item.id)}
                                disabled={pendingResolveId === item.id}
                                aria-disabled={pendingResolveId === item.id}
                                className="px-3"
                              >
                                {pendingResolveId === item.id ? (
                                  <>
                                    <Loader2 className="size-4 animate-spin" aria-hidden />{' '}
                                    Resolving…
                                  </>
                                ) : (
                                  'Resolve'
                                )}
                              </Button>
                            ) : null}
                            {item.status === 'resolved' ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => void handleReopen(item.id)}
                                disabled={reopenPendingId === item.id}
                                aria-disabled={reopenPendingId === item.id}
                                className="px-3"
                              >
                                {reopenPendingId === item.id ? (
                                  <>
                                    <Loader2 className="size-4 animate-spin" aria-hidden />{' '}
                                    Reopening…
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
                                onClick={() => openFalsePositiveDialogSingle(item.id)}
                                disabled={fpSubmittingFor === item.id}
                                aria-disabled={fpSubmittingFor === item.id}
                                className="px-3"
                                data-testid="row-false-positive-cta"
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
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          {data.total > 0 ? (
            <nav
              aria-label="Alert pagination"
              className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3"
            >
              <output className="text-caption text-muted-foreground">
                Page {data.page} of {Math.max(1, Math.ceil(data.total / data.pageSize))}
              </output>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={data.page <= 1}
                  onClick={() => navigatePage(data.page - 1)}
                >
                  Previous page
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={data.page >= Math.ceil(data.total / data.pageSize)}
                  onClick={() => navigatePage(data.page + 1)}
                >
                  Next page
                </Button>
              </div>
            </nav>
          ) : null}
        </div>
      ) : null}

      {/* False-positive dialog — controlled by the page so the per-row
          button on /alerts and the bulk CTA on the action bar both
          share the same presentational mount. Dialog opens via
          openFalsePositiveDialogSingle/Bulk and closes after either
          a successful POST or a Cancel click. submitting: true
          disables both the Submit and Cancel buttons so a stale
          double-click can't drop the dialog mid-FAN-out. */}
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

      {/* Bulk-reopen dialog — opt-in reason prompt before the bulk
          fan-out fires. Mirrors the FP dialog posture (page-owned
          open state, presentational mount, disabled submit while
          the fan-out is in flight) but with a loosened submit gate
          so an empty reason is valid on the reopen path — parity
          with the single-row reopen composer that sends `{}` from
          /alerts/[id]. Label sits at "N selected alerts" so the
          operator knows the body shape applies to the whole
          working set, not just one row. */}
      <AlertsReopenDialog
        open={reopenDialogOpen}
        onOpenChange={(next) => {
          if (reopenSubmitting && !next) return;
          setReopenDialogOpen(next);
        }}
        onSubmit={submitBulkReopen}
        submitting={reopenSubmitting}
        targetLabel={`${selection.size} selected ${selection.size === 1 ? 'alert' : 'alerts'}`}
      />

      {/* Bulk-resolve dialog — opt-in note prompt before the bulk
          resolve fan-out fires. Sister to the reopen dialog: page-
          owned open state, presentational mount, disabled submit
          while the fan-out is in flight, and the same submit gate
          (an empty note is valid and stamps NULL on every row via
          the bare `{}` body). Label sits at "N selected alerts"
          so the operator knows the body shape applies to the
          whole working set, not just one row. */}
      <AlertsResolveDialog
        open={resolveDialogOpen}
        onOpenChange={(next) => {
          if (resolveSubmitting && !next) return;
          setResolveDialogOpen(next);
        }}
        onSubmit={submitBulkResolve}
        submitting={resolveSubmitting}
        targetLabel={`${selection.size} selected ${selection.size === 1 ? 'alert' : 'alerts'}`}
      />
    </div>
  );
}
