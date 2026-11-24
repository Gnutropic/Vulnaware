// @polsia:user-owned — URL round-trip helper for the /alerts page chip
// state + text/date/selection inputs. Extracted verbatim from
// page.tsx's `effectiveQs` `useMemo` so the round-trip (brief case #2)
// can run as a unit test without rendering the page. Behavior is
// identical:
//   - writer writes: severity (`Set<SeverityLiteral> | null` — multi-
//     select posture, `null` strips the key, a populated Set emits
//     the canonical CSV via `formatSeverityFilter` e.g.
//     `?severity=critical,high`), status, triggeredBy, hideSnoozed,
//     ownedByMe (boolean-flag — literal '1'), remediatedOnly
//     (boolean-flag — literal '1'), snoozedOnly (boolean-flag —
//     literal '1'), openOnly (boolean-flag — emits literal
//     `status=open`), sort (!=='lastActivity' only — the brief's
//     new default), incoming q/from/to (preserve), since, asset
//     (non-empty only), selection (non-empty only).
//   - severity is multi-select: a chip click toggles membership in
//     the page-level Set; the writer emits the canonical critical →
//     high → medium → low CSV via `formatSeverityFilter`'s
//     `SEVERITY_RANK` join. A legacy `?severity=critical,high`
//     permalink feeds EVERY literal into the page-level Set (parse
//     and round-trip through `formatSeverityFilter`); a single-
//     literal `/alerts?status=open&severity=critical` deep-link
//     from the dashboard tile lands at the single-element Set
//     `{critical}` (single chip lit). The page-level Set semantics
//     cover the legacy permalink, the dashboard-tile deep-link, and
//     the new multi-select UI without a separate collapse path.
//   - writer omits any key whose value is null/false/undefined, so a
//     chip click never silently drops text input state and typing `q`
//     never wipes a chip-state. Every key rides the URL — the page
//     URL writer reads contemporaneous state every chip click.
//   - writer omits `selected=` when the bulk-action working set is
//     empty so the URL never carries a dangling `?selected=`.
//   - writer omits `asset=` when the chip-set is empty (or null) so a
//     cleared chip strip drops the key cleanly — that's the "inline ×
//     clears ONLY asset" criterion the brief pins.
//   - writer emits `hideSnoozed=1` ONLY when the chip is flipped on;
//     absent = `` (snoozed rows surface naturally, the default).
//   - writer emits `ownedByMe=1` ONLY when the toggle is active;
//     absent = the all-alerts view (default). The wire shape is the
//     boolean-flag literal, NOT the legacy enum `ownedBy=me`.
//   - writer emits `remediated=1` ONLY when the toggle is active;
//     absent = the all-alerts view (default). Mirrors `ownedByMe`
//     verbatim — same boolean-flag wire shape, same chip-row
//     pattern. The route's `?remediated=1` narrowing hands the
//     filter to /api/alerts AND /api/alerts/export.csv so a filtered
//     view downloads a matching CSV. Resting state (default
//     `false`) strips the key from the URL so a chip click never
//     silently drops it on a re-fetch.
//   - writer emits `snoozed=1` ONLY when the toggle is active;
//     absent = the all-alerts view (default). Mirrors `remediated`
//     verbatim — same boolean-flag wire shape, same chip-row
//     pattern. The route's `?snoozed=1` narrowing hands the filter
//     to /api/alerts AND /api/alerts/export.csv so a filtered view
//     downloads a matching CSV. The narrowing semantic is
//     `snoozedUntil > now` (active snooze window) — matches the
//     bulk-resolve / claim "exclude future snoozes" posture
//     verbatim. Resting state (default `false`) strips the key
//     from the URL so a chip click never silently drops it on a
//     re-fetch.
//   - The visible status row uses the `status` query key for every
//     stored state and the derived `snoozed` filter. `openOnly` and
//     `resolvedOnly` remain internal aliases for API parsing and retain
//     their existing wire values.
//
// Pure function — no React, no router, no DB. The single point the
// brief's URL round-trip tests target.

import { formatAssetFilter } from '@/lib/business/alerts-asset';
import { buildSelectedParam } from '@/lib/business/alerts-selection';
import { formatSeverityFilter, type SeverityLiteral } from '@/lib/business/alerts-severity';
import type { SinceFilter } from '@/lib/business/alerts-since';
import { type AlertSortKey, type ResolutionFilter, StatusFilterWire } from '@/lib/contracts/alerts';

export type AlertWorkflowStatus = typeof StatusFilterWire._type;
export type AlertWorkflowStatusFilter = AlertWorkflowStatus | null;

export function parseAlertWorkflowStatus(value: string | null): AlertWorkflowStatusFilter {
  const parsed = StatusFilterWire.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// Mirror of the `OwnedByMeFlag` chip-local type on
// `@/components/dashboard/alerts-owner-chip-row`. Keeping the business
// type inlined here (rather than re-exporting from the chip component)
// preserves the layering direction — the chip is a 'use client'
// component, the business lib is pure logic that runs in node tests
// too. The two literal manifests MUST stay in lockstep; the chip row
// test pins this contract.
export type OwnedByMeFlag = boolean;

// `SnoozedOnlyFlag` mirrors `OwnedByMeFlag`'s lockstep posture: declared
// locally, pinned against the chip-local
// `SnoozedOnlyFlag = boolean` from
// `@/components/dashboard/alerts-snoozed-chip-row`. Both literals live
// here to keep the business lib free of a chip-component import (the
// layering direction the `OwnedByMeFlag` lockstep already pins).
export type SnoozedOnlyFlag = boolean;

// The Open option keeps an internal boolean alias because the API
// applies an additional active-snooze-window predicate to status=open.
export type OpenOnlyFlag = boolean;

// ResolvedOnlyFlag mirrors the existing status=resolved query value.
export type ResolvedOnlyFlag = boolean;

export interface EffectiveQsInput {
  // High-level resolution filter. The page supplies its explicit default
  // (`unresolved`); leaving this undefined preserves older pure-helper
  // callers and their existing query output.
  resolution?: ResolutionFilter;
  // Multi-select posture: `null` strips the key, an empty Set
  // strips the key, and a populated Set emits the canonical CSV
  // through `formatSeverityFilter` (critical → high → medium → low).
  // The page's `parseFiltersFromParams` feeds EVERY parsed literal
  // from a legacy `?severity=critical,high` permalink INTO the Set
  // (no collapse), so the URL round-trips byte-stably on every
  // permalink form.
  severity: Set<SeverityLiteral> | null;
  // Stored statuses share this query parameter with the derived active
  // snooze-window filter.
  status: AlertWorkflowStatusFilter;
  triggeredBy: 'ci-webhook' | 'scheduled' | 'manual' | null;
  hideSnoozed: boolean;
  // Filter chip for alerts whose associated asset has a high-risk finding.
  // The resting false state removes the key without disturbing the other
  // URL-owned filters.
  highRiskAssets: boolean;
  ownedByMe: OwnedByMeFlag;
  // Filter chip for "Remediated only" — narrows the resultset to
  // rows whose `Alert.remediatedAt` is non-null. Boolean-flag wire
  // shape (mirror of `ownedByMe`); the resting `false` state strips
  // the key from the URL so a chip click never silently drops it
  // on a re-fetch. The wire shape typed here as `boolean` mirrors
  // the chip-local `RemediatedOnlyFlag = boolean` literal declared
  // on `@/components/dashboard/alerts-remediated-chip-row`; both
  // declarations live in lockstep.
  remediatedOnly: boolean;
  // Filter chip for "Snoozed only" — narrows the resultset to
  // rows with an ACTIVE snooze window (`Alert.snoozedUntil > now`).
  // Boolean-flag wire shape (mirror of `remediatedOnly` / `ownedByMe`);
  // the resting `false` state strips the key from the URL so a chip
  // click never silently drops it on a re-fetch. The wire shape
  // typed here as `boolean` mirrors the chip-local
  // `SnoozedOnlyFlag = boolean` literal declared on
  // `@/components/dashboard/alerts-snoozed-chip-row`; the narrowing
  // semantic byte-matches the bulk-resolve helper
  // (`alerts-bulk-resolve.ts`) and the claim route's "exclude
  // future snoozes" posture verbatim.
  //
  // COMPOSITION posture (distinct from the other three boolean-flag
  // chips): the Snoozed chip composes with every other chip +
  // input — activation flips this flag on without cross-clearing
  // the other boolean-flag chip states, and toggle-off drops only
  // this arm so the previously combined filter state is restored
  // without a page refresh. The writer reads contemporaneous state
  // every emission so toggling off restores the prior composition
  // automatically through the same `effectiveQs` writer (the writer
  // emits `?snoozed=1` absent when the flag is `false`, leaving the
  // rest of the keys intact).
  snoozedOnly: SnoozedOnlyFlag;
  // Filter chip for "Open only" — narrows the resultset to rows
  // whose `Alert.status === 'open'` AND whose `snoozedUntil` is
  // either NULL or in the past (NOT a future active snooze). The
  // wire shape is the LITERAL string `'open'` (`?status=open`), NOT
  // the boolean-flag literal `'1'` the rest of the boolean-flag
  // family uses — see the wire-key collision note on the
  // `OpenOnlyFlag` type above and on alerts-open-chip-row.tsx. The
  // writer's precedence is `openOnly > status`: when `openOnly` is
  // true the writer emits `?status=open` and SKIPS the enum's
  // writer line; when `openOnly` is false (the default resting
  // state) the enum's writer line runs unchanged so the enum's
  // `in_progress|resolved|false_positive` literals round-trip
  // verbatim.
  openOnly: OpenOnlyFlag;
  // Internal resolved alias retained for existing status URL parsing.
  resolvedOnly: ResolvedOnlyFlag;
  sort: AlertSortKey;
  since: SinceFilter;
  asset: Set<string> | null;
}

// Compose the chip-state + selection + text/date inputs into the
// canonical query-string the page/route both read. Returns "" when no
// keys apply (the `?` is the page-side separator, not the helper's
// concern).
export function buildEffectiveQs(
  input: EffectiveQsInput,
  incomingSearchParams: URLSearchParams,
  selection: Set<string>,
): string {
  const params = new URLSearchParams();
  // These supported filters do not have page-local controls, so keep
  // their original values when another control writes the URL.
  for (const key of ['source', 'acknowledged', 'assigneeReady'] as const) {
    const value = incomingSearchParams.get(key);
    if (value !== null) params.set(key, value);
  }
  if (input.resolution) params.set('resolution', input.resolution);
  const severityCsv = formatSeverityFilter(input.severity);
  if (severityCsv) params.set('severity', severityCsv);
  // Status filters share one query key: Open takes precedence if both
  // internal flags are unexpectedly set; otherwise Resolved takes
  // precedence over the ordinary status-row value.
  if (input.openOnly) {
    params.set('status', 'open');
  } else if (input.resolvedOnly) {
    params.set('status', 'resolved');
  } else if (input.status) {
    params.set('status', input.status);
  }
  if (input.triggeredBy) params.set('triggeredBy', input.triggeredBy);
  if (input.hideSnoozed) params.set('hideSnoozed', '1');
  if (input.highRiskAssets) params.set('highRiskAssets', '1');
  if (input.ownedByMe) params.set('ownedByMe', '1');
  if (input.remediatedOnly) params.set('remediated', '1');
  if (input.snoozedOnly) params.set('snoozed', '1');
  // ?sort= writer — emit the brief-friendly snake_case wire shape on
  // every arm so a bookmarked URL, a re-clicked dropdown option,
  // and a CSV download anchor round-trip the same snake_case form.
  // The wire mapping is:
  //   - `lastActivity` (default) → `last_activity` (snake_case per
  //                               the brief's literal, so URL
  //                               text reads naturally).
  //   - `lastActivity:asc`       → `last_activity_asc`.
  //   - `created`                → `created` (camelCase — the
  //                               existing schema wire shape, kept
  //                               so the legacy `?sort=newest`
  //                               permalink's `created` literal
  //                               round-trips verbatim).
  //   - `created:asc`            → `created_asc`.
  //   - `severity`               → emit verbatim.
  //   - `severity:asc`           → `severity_asc`.
  //   - `status`                 → emit verbatim.
  // Every arm rides the URL — including the default — so the round-
  // trip survives a paste-back, a CSV anchor, and a share link. The
  // schema's AlertQuery zod parse accepts BOTH `?sort=last_activity`
  // (the brief's literal) AND `?sort=lastActivity` (back-compat for
  // bookmarked visitors) via a transform alias, so a URL emitted
  // here parses back to the same internal `lastActivity` default.
  // The `severity_asc` alias likewise parses to the internal
  // `severity:asc` comparator key.
  switch (input.sort) {
    case 'lastActivity':
      params.set('sort', 'last_activity');
      break;
    case 'lastActivity:asc':
      params.set('sort', 'last_activity_asc');
      break;
    case 'created:asc':
      params.set('sort', 'created_asc');
      break;
    case 'created':
      params.set('sort', 'created');
      break;
    case 'severity':
      params.set('sort', 'severity');
      break;
    case 'severity:asc':
      params.set('sort', 'severity_asc');
      break;
    case 'status':
      params.set('sort', input.sort);
      break;
    case 'riskScore':
      params.set('sort', input.sort);
      break;
    case 'riskScore:asc':
      params.set('sort', input.sort);
      break;
    default:
      // Should not happen given the typed input, but keep an
      // explicit fallback rather than silently dropping an unknown
      // wire arm.
      params.set('sort', String(input.sort));
  }
  if (input.since) params.set('since', input.since);
  const assetCsv = formatAssetFilter(input.asset);
  if (assetCsv) params.set('asset', assetCsv);

  const incomingQ = incomingSearchParams.get('q');
  const incomingHostname = incomingSearchParams.get('hostname');
  const incomingFrom = incomingSearchParams.get('from');
  const incomingTo = incomingSearchParams.get('to');
  if (incomingQ) params.set('q', incomingQ);
  if (incomingHostname) params.set('hostname', incomingHostname);
  if (incomingFrom) params.set('from', incomingFrom);
  if (incomingTo) params.set('to', incomingTo);
  const incomingPage = incomingSearchParams.get('page');
  const incomingPageSize = incomingSearchParams.get('pageSize');
  if (incomingPage) params.set('page', incomingPage);
  if (incomingPageSize) params.set('pageSize', incomingPageSize);

  const selectedStr = buildSelectedParam(selection);
  if (selectedStr != null) params.set('selected', selectedStr);

  const s = params.toString();
  return s ? `?${s}` : '';
}

// Build the URL for a page control by changing only the page key. The
// effective query already contains the canonical active filters, so keeping
// the other parameters intact makes a page link a faithful permalink to the
// operator's current view.
export function buildAlertPageHref(currentQuery: string, page: number): string {
  const query = currentQuery.startsWith('?') ? currentQuery.slice(1) : currentQuery;
  const params = new URLSearchParams(query);
  if (page <= 1) params.delete('page');
  else params.set('page', String(page));
  const search = params.toString();
  return `/alerts${search ? `?${search}` : ''}`;
}
