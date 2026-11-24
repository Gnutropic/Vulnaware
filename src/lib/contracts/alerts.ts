// @polsia:user-owned — Public-facing wire contracts for the per-team alerts
// read API. Mirrors audit-event.ts: pure zod schemas, NO server-only / db
// imports so both the /api/alerts route and a future client island can
// share the same validation.
//
// `assigneeReady` is derived at the route layer from `acknowledged === false
// AND assigneeId IS NULL` — it is NOT a stored column. Surfacing it as a
// filter keeps the UI's "ready to assign" view a one-call proposition
// instead of post-filtering on the client.
//
// `asset` is the multi-select composite `${host}:${port}/${protocol}`
// filter — same wire shape the /assets page already deep-links to via
// `/alerts?asset=<encoded name>` (no behavior change for /assets, but
// today the alerts page ignores the key — the asset chip-row makes it
// a real filter). The page parses to a `Set<string>` of composite
// names; the routes further decompose each name into a `<host>/<port>
// /<protocol>` triplet and apply `finding.asset.OR = [...]`. Wire
// shape is comma-separated, alphabetical canonical, length-capped.
// See `@/lib/business/alerts-asset` for the helpers + the cap.
//
// Boolean query values: zod's `z.coerce.boolean()` uses JS `Boolean(value)`
// which coerces 'false' to true. We use a small swap that maps both 'true'
// / 'false' strings AND native booleans into the expected boolean.

import { z } from 'zod';
import { AlertDateBound } from '@/lib/contracts/alert-date-range';
import { NotificationDeliveryItem } from '@/lib/contracts/team-notifications';

const Boolish = z
  .union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])
  .optional();

export const AlertSource = z.enum(['kev', 'vulncheck', 'manual']);

// Triage state for the per-team alerts list. Mirrors the `AlertStatus` enum
// in prisma/schema/alerts.prisma. New rows default to 'open' so every row
// round-trips a value on the wire — the contract is intentionally NOT
// `optional()` on `AlertItem`. The detail page and alerts list can write
// this stored status through the shared status mutation.
// `false_positive` is appended LAST to keep the in-app comparator in
// src/lib/business/alerts-sort.ts lockstep with the Prisma enum ordinal —
// declaration order maps to comparator rank 0/1/2/3.
export const AlertStatus = z.enum(['open', 'in_progress', 'resolved', 'false_positive']);

export const ResolutionFilter = z.enum(['all', 'unresolved', 'resolved']);
export type ResolutionFilter = z.infer<typeof ResolutionFilter>;

// Wire-only enum that extends `AlertStatus` with the derived `'snoozed'`
// arm. `'snoozed'` is NOT a stored `Alert.status` value (Prisma's
// `AlertStatus` enum does not include it); the literal is a derived
// predicate that maps to `snoozedUntil > now` server-side. Surfacing
// it on the AlertQuery status filter lets the /alerts enum chip row
// emit `?status=snoozed` — the same effective query the existing
// `AlertsSnoozedChipRow` emits as `?snoozed=1`, but routed through
// the enum chip family so the wire-key precedence is identical to the
// rest of the enum (`in_progress | resolved | false_positive`). The
// alert row wire shape (`AlertItem.status`) STAYS locked to
// `AlertStatus` so a future caller can't stamp `'snoozed'` onto a
// row's status column (Prisma would reject it on write) — `snoozed`
// remains a derived-predicate filter only.
export const StatusFilterWire = z.enum([
  'open',
  'in_progress',
  'resolved',
  'false_positive',
  'snoozed',
]);
export type StatusFilterWire = z.infer<typeof StatusFilterWire>;

// Origin marker for the parent scan row, surfaced so the UI can stamp a
// "Triggered by" badge per alert and the chip-row on /alerts can filter.
// Mirrors src/lib/contracts/scan.ts ScanSourceEnum — kept as a separate
// alias so this contract stays decoupled from the scan-domain bundle
// (the /alerts page never needs the scan-side definitions).
export const TriggeredByEnum = z.enum(['ci-webhook', 'scheduled', 'manual']);

const AlertAsset = z.object({
  host: z.string(),
  port: z.number().int(),
  protocol: z.string(),
  riskScore: z.number().finite().nullable().optional(),
  // Server-derived only: present when the asset's scan belongs to the
  // caller's active workspace and the hostname can safely open its detail.
  detailHref: z.string().optional(),
});

export const AlertItem = z.object({
  id: z.string(),
  teamId: z.string(),
  findingId: z.string(),
  severity: z.string().nullable(),
  status: AlertStatus,
  source: AlertSource,
  assigneeId: z.string().nullable(),
  // Picker side-channel: the member id (FK to WorkspaceMember.id) and the
  // resolved display name. `ownerName` is `null` when (a) `ownerId IS NULL`
  // or (b) the underlying `User` row exists but `name` is missing (rare;
  // better-auth default seeds `name` to null). The wire shape is always the
  // pair — clients render either branch without a special case on missing-
  // owner.
  ownerId: z.string().nullable(),
  ownerName: z.string().nullable(),
  // Alert storage supplies this timestamp, but older or partial API payloads
  // may omit it. The alerts list keeps those rows and renders an explicit
  // "Unknown" age instead of failing the entire response contract.
  createdAt: z.string().nullish(),
  acknowledgedAt: z.string().nullable(),
  // ISO-8601 UTC ms, or null when no snooze is set (or the window has
  // elapsed but the column hasn't been cleared — the list treats that as
  // "ready to surface" so UI reads don't need a second client-side check).
  snoozedUntil: z.string().nullable(),
  cveId: z.string(),
  // Surfaced from the joined `CveEntry.description` — the NVD summary
  // text that the daily CVE feed ingests into the CveEntry cache.
  // Server-stamped client-side via a batched CveEntry.findMany peer-read
  // keyed by the page's cveIds (no Prisma relation exists between
  // VulnerabilityFinding and CveEntry so this is the only path that
  // avoids a schema shift + migration). `null` on rows whose CVE id has
  // no CveEntry row yet (cold-start / pre-ingest) so the UI can show an
  // em-dash without surfacing a stale literal.
  vulnerabilityTitle: z.string().nullable(),
  asset: AlertAsset,
  // Optional — older rows pre-dating the source column will round-trip
  // null. The UI falls back to the 'manual' label when this is absent so a
  // missing payload still renders.
  triggeredBy: TriggeredByEnum.optional(),
  // Server-derived "this row's CVE is in the workspace's current
  // VulnerabilityTrend signal.acceleratingIncreases". Stamped by
  // GET /api/alerts from a single `vulnerabilityTrend.findFirst` on
  // `(workspaceId, computedAt desc)` and matched via in-memory Set;
  // absent when the workspace has no trend row yet or when the row's
  // accelerating list is empty for this CVE.
  trending: z.boolean().optional(),
  // Server-derived count of `AlertComment` rows for this alert, scoped to
  // the caller's team via `alert: { teamId }` so a tampered page cannot
  // surface counts from another team's thread. Sparse `.optional()` keeps a
  // future stamp bug distinguishable from a real `0`; the happy path is
  // `commentCount: 0` stamped server-side, never absent.
  commentCount: z.number().int().nonnegative().optional(),
  // Operator-stamped reason when status === 'false_positive'. Null on every
  // other status — a non-FP row MUST NOT carry a suppression stamp. Read
  // off the `Alert.falsePositiveReason` column on /api/alerts (list) and
  // /api/alerts/[id] (detail) and cleared by /api/alerts/[id]/reopen so a
  // triage flip back to `open` never carries the suppression stamp forward.
  falsePositiveReason: z.string().nullable(),
  // Operator-stamped free-form note when status === 'resolved'. Null on
  // every other status — a non-resolved row MUST NOT carry a close note.
  // Read off `Alert.closingNote` (VARCHAR(500)) on /api/alerts (list) and
  // /api/alerts/[id] (detail). Cleared by /api/alerts/[id]/reopen so a
  // triage flip back to `open` never carries the close note forward.
  closingNote: z.string().nullable(),
  // Operator-stamped "I acted on this" stamp. Server-stamped from
  // `Alert.remediatedAt` on /api/alerts (list) and /api/alerts/[id]
  // (detail). Null on every unremediated row, including rows the
  // caller hasn't yet acted on (a row's `ownerId` may point at the
  // caller without `remediatedAt` set anywhere — the stamp is the
  // owner's manual flip, not a derived column). The wire shape is
  // ISO-8601 (refreshed every unification pass with the AlertItem
  // `createdAt` / `acknowledgedAt` / `snoozedUntil` field posture),
  // nullable exactly like the close-stamp and reopen-stamp fields
  // above.
  remediatedAt: z.string().nullable(),
  // Operator's email stamp captured at the same time `remediatedAt`
  // is set. Read off `Alert.remediatedByEmail` on /api/alerts (list)
  // and /api/alerts/[id] (detail) and stamped onto every
  // AlertItem/AlertDetail envelope as a render-only identifier (so the
  // row-level chip stack can render "Remediated by <email>" without a
  // second round trip). Nullable everywhere — `null` on every
  // unremediated row (the column is unset until the first `set: 'now'`
  // write) AND `null` on any row stamped by a caller whose
  // `WorkspaceMember.email` AND `User.email` were both missing at
  // write-time (a sealed inbox / pre-claims profile). Mirrors the
  // wire-shape posture of `remediatedAt` exactly so the AlertItem and
  // AlertDetail envelopes share one column shape across the two
  // contracts.
  remediatedByEmail: z.string().nullable(),
  // Server-stamped "most recent activity" stamp. Derive-not-stored:
  // max(`Alert.remediatedAt`, MAX(`AlertNote.createdAt`)) per alert,
  // team-scoped on the peer-read so a tampered page cannot surface
  // cross-team note-maxes. Null when BOTH inputs are null (the
  // row has never been remediated AND has no handoff notes — the
  // vast majority of brand-new rows). Newer AlertNote overrides
  // Alert.remediatedAt when both exist, so an active shift handoff
  // surfaces even on a long-since-remediated row. Wire shape is
  // ISO-8601 nullable mirroring the remediatedAt stance above.
  lastActivityAt: z.string().nullable(),
  // Operator-stamped "Explain with AI" prose + timestamp —
  // surfaces the latest cached `AlertExplanation` row so /alerts
  // row-level cells can render an "AI explained" badge without a
  // second round trip. Null on every row whose `explain` POST
  // hasn't yet streamed (the common path on a fresh alert).
  // Mirrors the AlertItem counterpart exactly so list + detail
  // share one column shape end-to-end; the wire envelopes flow
  // through /api/alerts (list) and /api/alerts/[id] (detail) and
  // are stamped onto both `AlertItem.parse(...)` and
  // `AlertDetail.parse(...)` calls alongside the existing
  // close-stamp / reopen-stamp / remediated-stamp trio on the
  // same `findUnique` / `findMany` projection.
  lastExplainedAt: z.string().nullable(),
  lastExplanationText: z.string().nullable(),
});

export const AlertList = z.object({
  items: z.array(AlertItem),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  // Per-severity counts for the current, fully filtered inventory view.
  // Counts include the active search, severity, status/resolution, and all
  // other list filters, but never pagination or sort. `snoozed` remains the
  // compatibility side count for the existing Snoozed chip consumer.
  counts: z.object({
    critical: z.number().int(),
    high: z.number().int(),
    medium: z.number().int(),
    low: z.number().int(),
    snoozed: z.number().int().nonnegative(),
  }),
  // Distinct non-blank severity values represented anywhere in the active
  // workspace. Standard values and free-form legacy values both round-trip
  // as stored strings; the client derives labels and color tokens.
  severityOptions: z.array(z.string().min(1)),
});

export type AlertCounts = z.infer<typeof AlertList>['counts'];

export const AlertQuery = z.object({
  // High-level resolution filter. An absent value preserves the alerts
  // page's existing unresolved-only default; `status` remains available
  // for the detailed lifecycle chips.
  resolution: ResolutionFilter.optional(),
  severity: z.string().optional(),
  source: AlertSource.optional(),
  // Optional filter on the parent scan row's source. Drives the chip row
  // above the alerts table; absent = no filter (show all).
  triggeredBy: TriggeredByEnum.optional(),
  // Optional triage-state filter. Mirrors AlertStatus on the wire (NOT a
  // free-form string) so a typo-flipped chip 400s through the schema rather
  // than silently narrowing nothing. Widened to `StatusFilterWire` (extends
  // `AlertStatus` with the derived `'snoozed'` arm) so the /alerts enum
  // chip row can also fire `?status=snoozed`, which the route resolves to
  // `{ snoozedUntil: { gt: new Date() } }` — the same effective query the
  // existing `AlertsSnoozedChipRow`'s `?snoozed=1` produces. The
  // AlertItem.status field below STAYS locked to `AlertStatus` (the
  // stored Prisma enum); `'snoozed'` is a filter-only literal.
  status: StatusFilterWire.optional(),
  acknowledged: Boolish,
  assigneeReady: Boolish,
  // Optional hide-snooze toggle. Absent (the default) surfaces snoozed
  // rows with the row's "Snoozed until …" badge intact; the literal
  // string `'1'` filters them out. Elapsed snoozes (snoozedUntil <=
  // now) always surface — the route narrows by `(IS NULL OR <= now)`,
  // letting a re-visit of /alerts show all the old-but-no-longer-snoozed
  // rows naturally when the toggle is off. The wire shape is the literal
  // `'1'` (NOT `'true' | 'false' | Boolish`) so the URL round-trip is
  // `?hideSnoozed=1` verbatim — any other value (e.g. `?hideSnoozed=true`
  // or `?hideSnoozed=`) parses as absent (snoozed rows visible).
  hideSnoozed: z.literal('1').optional(),
  // Optional high-risk asset filter. The literal wire value keeps the URL
  // contract explicit: absent means all authorized alerts, while `1` keeps
  // only alerts whose associated finding has a priority score at or above
  // the shared high-risk threshold.
  highRiskAssets: z.literal('1').optional(),
  // Free-form text query. Trimmed, 1–200 chars. Resolved server-side as
  // three OR arms in `buildAlertSearchWhere`: (1) case-insensitive
  // SUBSTRING match on `cveId` (`cveId contains q, mode: 'insensitive'`)
  // — so typing `CVE-2024-` matches any cveId starting with that
  // prefix; (2) case-insensitive SUBSTRING match on the joined
  // `CveEntry.description` (surfaced client-side as `vulnerabilityTitle`,
  // resolved via a pre-query because no Prisma relation exists); (3)
  // case-insensitive SUBSTRING match on `Asset.host` — a direct nested
  // Prisma filter (`finding.asset.host contains q`), no pre-query needed.
  q: z.string().trim().min(1).max(200).optional(),
  // Dedicated asset-hostname query for the /alerts toolbar. It stays
  // separate from `q` so the existing CVE/title search semantics remain
  // unchanged while hostname-only searches compose with other filters.
  hostname: z.string().trim().min(1).max(200).optional(),
  // Multi-select asset filter — composite `${host}:${port}/${protocol}`
  // keys, comma-separated. The string is free-form-validity only at the
  // schema layer: the route further decomposes each entry into a
  // `<host>/<port>/<protocol>` triplet via `parseAssetNamesToOrList`
  // (helper @/lib/business/alerts-asset) and 400s on a malformed name.
  // Length-capped server-side (see `MAX_ASSET_FILTER_ENTRIES`) so a
  // malicious URL can't drive an unbounded `OR[]` clause. Same key
  // powers the /assets deep-link `/alerts?asset=<encoded name>`.
  asset: z.string().trim().min(1).max(8000).optional(),
  // Inclusive calendar-date bounds on `createdAt`; explicit ISO timestamps
  // remain supported for existing API links.
  from: AlertDateBound.optional(),
  to: AlertDateBound.optional(),
  // Trailing-N-days preset — narrows to rows where `createdAt` OR the
  // more-recent of `{createdAt, statusChangedAt}` falls inside the
  // window. Distinct from `from`/`to` (inclusive bounds on createdAt):
  // composes with every other filter, the search box, sort, and the CSV
  // export. The enum is widened now to ['7d','30d','90d'] so adding a
  // later preset doesn't reshape the wire contract; v1 only surfaces
  // '7d' on the chip row. A typo'd value (e.g. `since=8d`) 400s through
  // the schema rather than silently narrowing nothing.
  since: z.enum(['7d', '30d', '90d']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  // Sort mode for both /api/alerts (paginated) and /api/alerts/export.csv
  // (streaming). Default `lastActivity` (DESC) so a missing/unparseable
  // param strips cleanly off the URL via the page's `effectiveQs` writer.
  // Mirrored verbatim by the comparator in
  // src/lib/business/alerts-sort.ts so the server cursor and the client
  // comparator always agree. Each arm names its direction inline:
  //   - `newest`           — legacy permalink alias; the schema transform
  //                          maps it to `created` (DESC). Backend SQL
  //                          `orderBy: { createdAt: 'desc' }` — monotone
  //                          and index-covered for stable pagination.
  //   - `severity`         — critical → high → medium → low → null sink
  //                          (DESC); tiebreak by hostname ascending then
  //                          alert ID ascending. The API orders a narrow
  //                          projection of the full filtered result before
  //                          selecting the page, then loads full rows.
  //   - `severity:asc`     — low → medium → high → critical →
  //                          null/unknown (ASC); ties use the same
  //                          hostname-then-ID order as DESC. URL form is
  //                          `severity_asc`.
  //   - `status`           — Prisma enum ordinal ASC (open=0 <
  //                          in_progress=1 < resolved=2 <
  //                          false_positive=3). SQL
  //                          `orderBy: [{status:asc},{createdAt:desc},{id:desc}]`.
  //                          Non-directional in practice; the dropdown
  //                          never exposes an ASC arm.
  //   - `lastActivity`     — `Date.parse(b.lastActivityAt ?? b.createdAt)
  //                          - Date.parse(a.lastActivityAt ?? a.createdAt)`
  //                          (DESC); tiebreak on createdAt desc then id
  //                          desc. Same posture as severity: the SQL
  //                          cursor stays monotone `createdAt desc`; the
  //                          in-app page-slice re-rank keeps the visible
  //                          table on the `lastActivity` order. Empty /
  //                          null `lastActivityAt` falls back to
  //                          `createdAt` so a row whose derivation
  //                          resolved to null still ranks on its creation
  //                          timestamp rather than sinking to the bottom.
  //                          **Default** — the brief's "align with the
  //                          Last activity column" stance. Wire form on
  //                          the URL is `last_activity` (snake_case per
  //                          the brief); the writer in
  //                          `@/lib/business/alerts-effective-qs` emits
  //                          `?sort=last_activity` while the internal
  //                          AlertSortKey type stays camelCase.
  //   - `lastActivity:asc` — same rank key as `lastActivity`, ASCENDED;
  //                          NULL `lastActivityAt` sinks to the bottom
  //                          via the `?? createdAt` fallback. URL emit
  //                          form is `last_activity_asc` (snake_case +
  //                          direction suffix). The dropdown's "Last
  //                          activity (Oldest first)" option rides this
  //                          arm.
  //   - `created`          — `createdAt desc`. Wire form `created`
  //                          (no direction suffix — the camelCase form
  //                          pairs with the legacy `newest` rename).
  //                          The dropdown's "Created (most recent
  //                          first)" option rides this arm.
  //   - `created:asc`      — `createdAt asc`. Wire form `created_asc`.
  //                          The dropdown's "Created (oldest first)"
  //                          option rides this arm.
  //   - `last_activity`    — brief-friendly snake_case alias for
  //                          `lastActivity` (DESC). Transformed on parse
  //                          so a bookmarked `?sort=last_activity` URL
  //                          surfaces the same sort semantics as the
  //                          camelCase form. Back-compat with the brief's
  //                          literal wire naming.
  // `status` is kept in the schema for legacy URLs even though the
  // dropdown no longer renders it — matches the contract posture
  // already declared.
  sort: z
    .enum([
      'newest',
      'created',
      'severity',
      'severity_asc',
      'status',
      'lastActivity',
      'lastActivity:asc',
      'created:asc',
      'created_asc',
      'last_activity',
      'riskScore',
      'riskScore:asc',
      'risk_score',
      'risk_score_asc',
    ])
    .transform((v) => {
      if (v === 'newest') return 'created';
      if (v === 'last_activity') return 'lastActivity';
      if (v === 'created_asc') return 'created:asc';
      if (v === 'severity_asc') return 'severity:asc';
      if (v === 'risk_score') return 'riskScore';
      if (v === 'risk_score_asc') return 'riskScore:asc';
      return v;
    })
    .default('lastActivity'),
});

export type AlertItem = z.infer<typeof AlertItem>;
export type AlertList = z.infer<typeof AlertList>;
export type AlertQuery = z.infer<typeof AlertQuery>;
export type AlertSortKey = z.infer<typeof AlertQuery>['sort'];

// Single-alert envelope served by GET /api/alerts/[id]. Reuses the trigger
// and source enums (kept in this file rather than imported from scan.ts so
// the alerts contract stays decoupled) and extends `AlertAsset` with the
// extra fields the list shape drops (id + ip + lastSeen). The detail page's
// affected-assets table renders one row from the underlying finding's asset
// — see the route handler for why "all assets across the team with this
// CVE" is the future expansion, not today's contract.
const AlertDetailAsset = AlertAsset.extend({
  id: z.string(),
  ip: z.string(),
  lastSeen: z.string().nullable(),
  // Detail responses always include these fields so the affected-assets
  // surface can distinguish an unavailable value from an older payload.
  riskScore: z.number().finite().nullable(),
  latestScanStatus: z.enum(['queued', 'running', 'completed', 'failed']).nullable(),
  latestScanAt: z.string().datetime().nullable(),
  hasCompletedScan: z.boolean(),
});

export const AlertDetail = z.object({
  id: z.string(),
  teamId: z.string(),
  findingId: z.string(),
  severity: z.string().nullable(),
  // Mirror of `AlertItem.status` so the detail page can render an
  // authoritative chip + gate the "Mark as resolved" CTA without an extra
  // round trip. The /api/alerts/[id] route stamps it from
  // `Alert.status`; the resolver route stamps `statusChangedAt` on the
  // same envelope so the chip + the resolved CTA share one snapshot.
  status: AlertStatus,
  // ISO-8601 — stamped on every transition (open → in_progress →
  // resolved, or re-opened). Drives the "Resolved at …" cell on the
  // detail card; null until the row is flipped to resolved.
  statusChangedAt: z.string().nullable(),
  source: AlertSource,
  // Same pair shape as `AlertItem` so the detail read and the PATCH /owner
  // response parse against the same wire envelope. Resolution rules match
  // the list endpoint: null when unowned OR when `User.name` is missing.
  ownerId: z.string().nullable(),
  ownerName: z.string().nullable(),
  createdAt: z.string(),
  acknowledgedAt: z.string().nullable(),
  // ISO-8601 UTC ms, or null when no snooze is set. Drives the snooze card on
  // the detail page — when non-null, the card renders the active "until …
  // X remaining" stamp; when null, the 1d / 7d / 30d buttons are the primary
  // surface.
  snoozedUntil: z.string().nullable(),
  cvssScore: z.number().nullable(),
  description: z.string(),
  cveId: z.string(),
  asset: AlertDetailAsset,
  // Optional — older rows pre-dating the source column will round-trip
  // null. The UI falls back to the 'manual' label when this is absent.
  triggeredBy: TriggeredByEnum.optional(),
  // Whether the team has a notification webhook saved. Drives the "Open as
  // Jira ticket" button — true → POSTs /api/alerts/[id]/ticket; false →
  // navigates straight to /settings/integrations/notifications. Rides on
  // the existing detail GET so the button never falls out of sync with the
  // single authoritative read on the server.
  webhookConfigured: z.boolean(),
  // Server-derived "is the caller the alert's assignee". Drives the
  // assignee-only comment composer on /alerts/[id] (the post composer is
  // visible IFF true). Always computed server-side from
  // `Alert.ownerId === ctx.membership.id` so the UI never has to trust a
  // client-side flip to gate the writer. The pair lives on the existing
  // detail GET so the comment card mounts without an extra round trip.
  me: z.object({ isAssignee: z.boolean() }),
  // Operator-stamped reason when status === 'false_positive'. Null on
  // every other status. Cleared by /api/alerts/[id]/reopen when the row
  // moves back to `open` so a triage flip never carries the suppression
  // stamp forward. The detail endpoint stamps the same field from the
  // `Alert.falsePositiveReason` column so the detail page can render a
  // subtitle on the FP chip without a second read.
  falsePositiveReason: z.string().nullable(),
  // Close-stamp trio for `resolved` rows. Mirrors the AlertItem shape on
  // the wire so the detail page can render a "Resolved at …" subtitle +
  // body close-note WITHOUT a second round trip. All three fields are
  // nullable — `closedAt`/`closedBy` are stamped exactly once on the
  // FIRST transition to `resolved` (re-resolve preserves them), and
  // `closingNote` is null when the operator didn't ship a note. The
  // detail endpoint reads `closedBy` as a raw User.id — `closedByName`
  // resolution is the future expansion (batched
  // `prisma.user.findMany({ where: { id: { in: closedByIds } } })`,
  // mirror of `ownerName`); per the brief v1 stamps the id only.
  closedAt: z.string().nullable(),
  closedBy: z.string().nullable(),
  closingNote: z.string().nullable(),
  // Reopen-stamp trio. Mirrors the AlertResolveResponse trio so the
  // detail page can render a "Last reopened at …" subtitle + the
  // reopen reason body WITHOUT a second round trip on the activity
  // endpoint. All three fields are nullable — `reopenedAt` is stamped
  // once on the FIRST transition from `resolved` / `false_positive`
  // back to `open` (a re-reopen preserves it), and `reopenReason` is
  // null when the operator didn't ship a reason. The detail endpoint
  // reads `reopenedBy` as a raw User.id — `reopenedByName` resolution
  // is the future expansion (same batched `User.findMany` peer-read
  // as `ownerName`); per the brief v1 stamps the id only. The
  // activity card does the immediate name resolution
  // (GET /api/alerts/[id]/activity) so the timeline reads with
  // actor names today.
  reopenedAt: z.string().nullable(),
  reopenedBy: z.string().nullable(),
  reopenReason: z.string().nullable(),
  // Operator-stamped "I acted on this" stamp. Server-stamped from
  // `Alert.remediatedAt` on /api/alerts/[id] (the detail endpoint
  // stamps every stamp-bearing column on the row into the
  // AlertDetail.parse(...) call so the page renders the
  // "Remediated at …" subtitle without a second round trip). Null on
  // every unremediated row. The wire shape is ISO-8601 (mirrors the
  // AlertItem counterpart exactly), nullable like the close / reopen
  // triplets above. The button on the detail header reads this field
  // and the PATCH route echoes back a slim envelope that carries just
  // this column so the optimistic flip reconciles against the
  // server-authoritative stamp.
  remediatedAt: z.string().nullable(),
  // Operator's email stamp captured at the same time `remediatedAt`
  // is set. Read off `Alert.remediatedByEmail` on /api/alerts/[id]
  // (detail) and stamped onto the AlertDetail envelope as a
  // render-only identifier (so the detail header's "Remediated by
  // <email>" subtitle renders WITHOUT a second round trip AND so the
  // sibling AlertItem shape on /api/alerts reads off the same column
  // shape). Nullable everywhere — `null` on every unremediated row
  // AND on any row stamped by a caller whose WorkspaceMember.email
  // AND User.email were both missing at write-time. The detail
  // endpoint reads the column off the same `findUnique` query above
  // (Prisma returns every column by default) and stamps it here, so
  // adding this is just a wire-shape widening on the AlertDetail
  // parse call. Mirrors the AlertItem counterpart exactly so the two
  // contracts share one column shape end-to-end.
  remediatedByEmail: z.string().nullable(),
  // Server-stamped "most recent activity" stamp. Derive-not-stored:
  // max(`Alert.remediatedAt`, MAX(`AlertNote.createdAt`)) per alert,
  // team-scoped on the peer-read so a tampered page cannot surface
  // cross-team note-maxes. Null when BOTH inputs are null (the
  // row has never been remediated AND has no handoff notes — the
  // vast majority of brand-new rows). Newer AlertNote overrides
  // Alert.remediatedAt when both exist, so an active shift handoff
  // surfaces even on a long-since-remediated row. Wire shape is
  // ISO-8601 nullable mirroring the remediatedAt stance above.
  // Surfaced on the detail envelope so the activity sidebar can
  // render a "Last activity: <relative>(<absolute>)" subtitle line
  // without a second round trip.
  lastActivityAt: z.string().nullable(),
  // Operator-stamped "Explain with AI" prose + timestamp —
  // surfaces the latest cached `AlertExplanation` row so the
  // /alerts/[id] ExplainWithAiCard can pre-render the cached
  // prose on first paint WITHOUT a second round trip into
  // /api/alerts/[id]/explain (the brief asks the panel to
  // "survive a full page reload"). The detail endpoint reads
  // `explanationText` + `generatedAt` off the existing
  // `findUnique({ where: { id }, include: { explanation: { ...
  // } } })` query — no separate SELECT widening on the parent
  // Prisma row needed; the AlertExplanation back-ref rides the
  // existing `include` projection. Null when no POST has yet
  // streamed for this alert (the cache miss branch) — the
  // ExplainWithAiCard island still mounts in its click-to-stream
  // posture. Mirrors the AlertItem counterpart exactly so list
  // + detail share one column shape end-to-end.
  lastExplainedAt: z.string().nullable(),
  lastExplanationText: z.string().nullable(),
});

export type AlertDetail = z.infer<typeof AlertDetail>;

// PATCH body for /api/alerts/[id]/owner. `null` is the explicit
// "unassign" signal — the picker UI uses it for the "Unassigned" option.
// The handler validates `ownerId` is a real, active member of the same
// workspace before writing; the opposite-bound null just clears the FK.
export const AlertOwnerBody = z.object({
  ownerId: z.string().nullable(),
});

export type AlertOwnerBody = z.infer<typeof AlertOwnerBody>;
export type AlertOwnerBodyInput = z.input<typeof AlertOwnerBody>;

// Snooze-window duration literal. Server-side stamps a future `until`
// (now + WINDOW_MS[duration]) so client clock-skew never reaches the
// row. Used by both the single-id `[id]/snooze` route (alongside the
// `until` arm) AND the bulk `snooze-batch` route. Promoted to module
// scope so a future caller of either route reads the same literal.
// Widened to ['1d', '3d', '7d', '30d'] so the /alerts floating bulk-
// snap-bar's popover (1d / 3d / 7d / 30d picker) flows through a
// single literal end-to-end; the right-column SnoozeCard still ships
// its own hand-written options table so this widening does not reach
// that surface.
export const SnoozeDuration = z.enum(['1d', '3d', '7d', '30d']);
export type SnoozeDuration = z.infer<typeof SnoozeDuration>;

// POST body for /api/alerts/[id]/snooze. Accepts one of two shapes:
//
//   - `{ duration: '1d' | '3d' | '7d' | '30d' }` — the brief's primary
//     shape. Server-side stamps a future `until` (now + 1d / 3d / 7d /
//     30d) so the client's clock-skew never reaches the row. Powers the
//     header pill dropdown on /alerts/[id] (1d / 3d / 7d / 30d
//     options) — although the right-column SnoozeCard ships its own
//     hand-written `WINDOW_OPTIONS` table that ships only the 1d / 7d /
//     30d arms today, the wire schema accepts all four so a future
//     surface (e.g. a /alerts/[id] header pill widening) flows through
//     without a zod widening.
//   - `{ until: <ISO | null> }` — the prior shape, retained for the
//     standalone SnoozeCard mounted in the right column. `null` is the
//     explicit "un-snooze" signal; an invalid ISO 400s through the refine
//     so a UI typo is caught before it reaches the server-side Date
//     constructor.
//
// Discriminated union (`duration` vs `until`) so each arm is `.strict()`
// and a future caller field 400s through rather than silently accepting
// arbitrary keys (parity with `AlertResolveBody` / `AlertReopenBody` /
// `AlertOwnerBody`). When `duration` is parsed the route maps it to the
// same utc-ms target the `until` shape would have produced, so a
// downstream reader of `Alert.snoozedUntil` sees identical wire output
// from either shape.
export const AlertSnoozeBody = z.union([
  z
    .object({
      until: z
        .union([
          z.string().refine((v) => v.length > 0 && !Number.isNaN(Date.parse(v)), {
            message: 'Invalid ISO date string.',
          }),
          z.null(),
        ])
        .nullable(),
    })
    .strict(),
  z.object({ duration: SnoozeDuration }).strict(),
]);

export type AlertSnoozeBody = z.infer<typeof AlertSnoozeBody>;
export type AlertSnoozeBodyInput = z.input<typeof AlertSnoozeBody>;

// POST body for /api/alerts/snooze-batch. Sister to `AlertSnoozeBody`
// (snooze-by-id on /alerts/[id]) but takes a non-empty `ids` array
// that the route fans out in a single `prisma.$transaction`. Two
// arms, mirror of `AlertSnoozeBody`'s design:
//
//   - `{ ids, duration }` — the brief's primary shape. The route
//     stamps `now + WINDOW_MS[duration]` onto every row's
//     `snoozedUntil` so client clock-skew never reaches the row.
//     1d / 3d / 7d / 30d literals flow from the floating bulk-bar's
//     popover picker through one source-of-truth enum end-to-end.
//   - `{ ids, until }` — the new arm surfacing the floating bulk-
//     bar's custom-date popover entry. The route echoes a client-
//     supplied ISO verbatim (the SnoozeCard shape on the single-id
//     route already does this — parity so a future widening of
//     either surface cascades through a single union type). `null`
//     is the explicit "un-snooze" signal; an invalid ISO 400s
//     through the refine BEFORE the scope gate so a UI typo is
//     caught early.
//
// Discriminated union so each arm is `.strict()` and a future caller
// field 400s through rather than silently accepting arbitrary keys
// (parity with `AlertSnoozeBody` / `AlertBulkResolveBody` /
// `AlertResolveBody`). The shared `ids` field is mirrored across both
// arms — there is no empty-selection write path on the bulk route,
// schema enforces it server-side too so a non-React caller can't
// bypass it.
export const AlertBulkSnoozeBody = z.union([
  z
    .object({
      ids: z.array(z.string().min(1)).min(1),
      until: z
        .union([
          z.string().refine((v) => v.length > 0 && !Number.isNaN(Date.parse(v)), {
            message: 'Invalid ISO date string.',
          }),
          z.null(),
        ])
        .nullable(),
    })
    .strict(),
  z
    .object({
      ids: z.array(z.string().min(1)).min(1),
      duration: SnoozeDuration,
    })
    .strict(),
]);
export type AlertBulkSnoozeBody = z.infer<typeof AlertBulkSnoozeBody>;
export type AlertBulkSnoozeBodyInput = z.input<typeof AlertBulkSnoozeBody>;

// Served by POST /api/alerts/snooze-batch. Slim `{id, snoozedUntil}`
// envelope per row — mirrors the on-screen `AlertItem.snoozedUntil`
// column shape exactly so the helper's optimistic flip and a future
// refetch share the same wire contract without a round-trip parse.
export const AlertBulkSnoozeRow = z
  .object({
    id: z.string(),
    snoozedUntil: z.string().nullable(),
  })
  .strict();
export type AlertBulkSnoozeRow = z.infer<typeof AlertBulkSnoozeRow>;

// Served by POST /api/alerts/snooze-batch. `results` order mirrors
// the request's `ids` order (deduplicated) once filtered through the
// scope gate — the route silently drops cross-team ids and echoes
// only the ids the transaction actually wrote.
export const AlertBulkSnoozeResponse = z.object({
  results: z.array(AlertBulkSnoozeRow).min(0),
});
export type AlertBulkSnoozeResponse = z.infer<typeof AlertBulkSnoozeResponse>;

// AI summary served by GET/POST /api/alerts/[id]/summary. Cached one row
// per alert by AlertCveSummary; the GET is a pure read (the client treats
// `{ error: 'unavailable' }` as "not cached yet" and offers a Regenerate
// POST that forces a fresh model call). Both shapes share the alertId so
// the client can route state-machine updates without parsing both forms.
export const AlertSummary = z.object({
  alertId: z.string(),
  text: z.string(),
  // ISO-8601 — UTC ms serialized from JS Date().toISOString().
  generatedAt: z.string(),
  model: z.string().nullable(),
});
export type AlertSummary = z.infer<typeof AlertSummary>;

export const AlertSummaryUnavailable = z.object({
  error: z.enum(['not_found', 'unavailable']),
});
export type AlertSummaryUnavailable = z.infer<typeof AlertSummaryUnavailable>;

// Suggested fix served by GET/POST /api/alerts/[id]/suggested-fix. Cached
// one row per alert by AlertCveFix; the GET is a pure cache-read (the
// client treats `{ error: 'unavailable' }` as "not cached yet" and offers
// a Regenerate POST that forces a fresh model call). Each step carries
// a `title` (heading, ≤ 60 chars) and a copyable `body` (verbatim
// remediation text, ≤ 400 chars). The `id` is a stable hash the route
// computes server-side so the client can keyBy without recomputing.
export const AlertCveFixStep = z.object({
  id: z.string(),
  title: z.string().min(1),
  body: z.string().min(1),
});

export const AlertCveFix = z.object({
  alertId: z.string(),
  steps: z.array(AlertCveFixStep).min(1),
  // ISO-8601 — UTC ms serialized from JS Date().toISOString().
  generatedAt: z.string(),
  model: z.string().nullable(),
});
export type AlertCveFix = z.infer<typeof AlertCveFix>;
export type AlertCveFixStep = z.infer<typeof AlertCveFixStep>;

export const AlertCveFixUnavailable = z.object({
  error: z.enum(['not_found', 'unavailable']),
});
export type AlertCveFixUnavailable = z.infer<typeof AlertCveFixUnavailable>;

export const AlertCveFixInsufficientContext = z.object({
  error: z.literal('insufficient_context'),
  missing: z.array(z.enum(['cve', 'description'])).min(1),
});
export type AlertCveFixInsufficientContext = z.infer<typeof AlertCveFixInsufficientContext>;

export const AlertCveFixResponse = z.union([
  AlertCveFix,
  AlertCveFixUnavailable,
  AlertCveFixInsufficientContext,
]);
export type AlertCveFixResponse = z.infer<typeof AlertCveFixResponse>;

// "Suggest fix steps with AI" envelope served by POST
// /api/alerts/[id]/suggest-fix. Distinct from `AlertCveFix`:
// the cached suggested-fix panel is GET/POST against
// `/suggested-fix` (per-alert row upsert on every successful
// regeneration, with a 30-day freshness stamp), while the
// `suggest-fix` route returns the freshly-generated steps
// directly in the response body — no persistence, no GET
// handler, no freshness stamp reused across users. The
// distinct name (`AlertFixSteps` vs `AlertCveFix`) and
// distinct route task string (`cve-suggest-fix` vs
// `cve-suggested-fix`) keep the proxy's per-task metering
// disciplines the two surfaces separately so a future
// maintainer searching for callers of one cannot start
// silently hitting the other's cache.
//
// Step shape mirrors `AlertCveFixStep` end-to-end — same
// `id` / `title` / `body` triple, same trim/length caps —
// so a future refactor that unifies the four AI panels
// reads an obviously-paired pair of contracts in the same
// file.
export const AlertFixStepsStep = z.object({
  id: z.string(),
  title: z.string().min(1),
  body: z.string().min(1),
});

export const AlertFixSteps = z.object({
  alertId: z.string(),
  // 3–6 steps so the rendered panel reads as a focused
  // checklist rather than a flowing narrative; the upper
  // bound also gates runaway model output before the panel
  // renders.
  steps: z.array(AlertFixStepsStep).min(1).max(6),
  // ISO-8601 — UTC ms serialized from JS Date().toISOString()
  // (one-off generation stamp; never persisted).
  generatedAt: z.string(),
  model: z.string().nullable(),
});
export type AlertFixSteps = z.infer<typeof AlertFixSteps>;
export type AlertFixStepsStep = z.infer<typeof AlertFixStepsStep>;

export const AlertFixStepsUnavailable = z.object({
  error: z.enum(['not_found', 'unavailable']),
});
export type AlertFixStepsUnavailable = z.infer<typeof AlertFixStepsUnavailable>;

// "Explain with AI" brief served by GET /api/alerts/[id]/explain.
// Cached one row per alert by AlertExplanation (the latest stream
// the POST upserted); the GET is a pure cache-read (a `{ error:
// 'unavailable' }` body on cache miss so the ExplainWithAiCard
// distinguishes "not streamed yet" from "cross-team probe"). The
// POST still streams the SSE body and additionally writes the
// upsert after the upstream flushes — so a fresh explain round
// trip always populates the same row that the GET reads.
//
// Shape parallels `AlertSummary` so the ExplainWithAiCard island
// can read either endpoint with the same schema-typed parse —
// but the cached payload is `explanationText` (NOT `text`) so a
// future caller that imports `AlertExplanation` for a different
// operator surface can't silently bit-mismatch with the
// summary's "three-bullet lines" prose.
export const AlertExplanation = z.object({
  alertId: z.string(),
  text: z.string(),
  // ISO-8601 — UTC ms serialized from JS Date().toISOString().
  generatedAt: z.string(),
  model: z.string().nullable(),
});
export type AlertExplanation = z.infer<typeof AlertExplanation>;

export const AlertExplanationUnavailable = z.object({
  error: z.enum(['not_found', 'unavailable']),
});
export type AlertExplanationUnavailable = z.infer<typeof AlertExplanationUnavailable>;

// POST /api/alerts/[id]/ticket response. The route stamps a delivery row
// even when the webhook is unconfigured (matches the existing fan-out
// ring-buffer posture on /settings/integrations/notifications), so the
// body is ALWAYS parseable — the client renders latency/status inline
// regardless of which error branch landed.
//
// 503 is reserved for the explicit "no webhook configured" branch (which
// the client treats as a setup nudge). All other upstream failures ride
// 200 with `ok: false` and a typed `error` so the toast can copy a useful
// message without a second parse.
export const AlertTicketResponse = z.object({
  ok: z.boolean(),
  status: z.number().int().nullable(),
  latencyMs: z.number().int(),
  error: z.string().nullable(),
  delivery: NotificationDeliveryItem.nullable(),
});
export type AlertTicketResponse = z.infer<typeof AlertTicketResponse>;

// Daily CVE velocity trend signal — written by jobs/alerts-trend.ts
// once per UTC day and read by GET /api/alerts/trend.
//
// `velocity` is `recentCount - priorCount` (alert creation count over
// the last 30 days minus the prior 30-day window). Positive = the team
// is seeing MORE alerts than the prior period; negative = the team is
// seeing FEWER alerts. `acceleratingDeclines` is a list of CVE ids whose
// prior-30d count was > 0 AND whose recent-30d count is 0 — i.e. CVE
// traffic that has stopped showing up in the last 30 days after being
// active in the prior window. `acceleratingIncreases` is the inverse:
// CVE ids whose recent-30d count is strictly greater than the prior-30d
// count — CVE traffic the team is seeing MORE of right now, sorted by
// the increase (recent - prior) descending. Used by the /alerts row
// badge to stamp a `trending: true` marker on rows whose cveId is in
// the list, and by /alerts/trend/[cveId] to surface a single-CVE view.
// `hotspots` is the top-N recent `host:port` combinations ranked by
// alert count.
//
// Wire schema is intentionally permissive on counts (non-negative int)
// and strict on CVE id shape (string) so a malformed Prisma Json column
// parse surfaces a 500 rather than a silent zero-fill. The `.default([])`
// on the two CVE lists keeps back-compat clean: rows written by an older
// cron that shipped before `acceleratingIncreases` existed still parse;
// absence is treated as "no acceleration or decline signal".
export const VelocityTrendHotspot = z.object({
  host: z.string(),
  port: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
});
export type VelocityTrendHotspot = z.infer<typeof VelocityTrendHotspot>;

export const VelocityTrendSignal = z.object({
  velocity: z.number().int(),
  acceleratingDeclines: z.array(z.string()).default([]),
  acceleratingIncreases: z.array(z.string()).default([]),
  hotspots: z.array(VelocityTrendHotspot).default([]),
});
export type VelocityTrendSignal = z.infer<typeof VelocityTrendSignal>;

// Served by GET /api/alerts/trend when a row exists for the caller's
// workspace. `signal` is re-parsed through VelocityTrendSignal on the
// read path even though it is stored as Json so a schema drift surfaces
// at read time rather than silently shipping degraded data.
export const AlertTrendLatest = z.object({
  workspaceId: z.string(),
  windowStart: z.string(),
  windowEnd: z.string(),
  signal: VelocityTrendSignal,
  computedAt: z.string(),
});
export type AlertTrendLatest = z.infer<typeof AlertTrendLatest>;

// Served by GET /api/alerts/trend/[cveId] when the requested CVE is in
// the workspace's latest VulnerabilityTrend.acceleratingIncreases list.
// Returns the workspace-scoped velocity for the same window plus the
// per-CVE (recent, prior) counts so the detail island can render an
// "increased by N over the prior 30d" badge without a second round trip.
// 404 is returned when no trend row exists yet for the caller's
// workspace OR when the requested CVE is not currently accelerating
// (NOT a declines-noisy CVE, just not in `acceleratingIncreases`).
//
// `acceleratingIncreases` is NOT `.default([])` here: the route rebuilds
// the field from `VelocityTrendSignal.parse(...)`'s output, which already
// guarantees a string[]. The `.default([])` lives on VelocityTrendSignal so
// cold-start JSON still parses at the read site; carrying it again on this
// outbound contract makes the inferred API-fetch type carry `string[] |
// undefined` and clashes with the success-state shape on the island.
export const AlertTrendDetail = z.object({
  workspaceId: z.string(),
  cveId: z.string(),
  velocity: z.number().int(),
  recentCount: z.number().int().nonnegative(),
  priorCount: z.number().int().nonnegative(),
  // Full accelerating list so the detail island can link neighboring
  // CVEs without re-fetching /api/alerts/trend.
  acceleratingIncreases: z.array(z.string()),
  windowStart: z.string(),
  windowEnd: z.string(),
  computedAt: z.string(),
});
export type AlertTrendDetail = z.infer<typeof AlertTrendDetail>;

// Cold-start envelope. The /api/alerts/trend handler returns this shape
// when no VulnerabilityTrend row exists yet for the caller's workspace
// (before the first jobs/alerts-trend.ts tick has run). 404 is also a
// valid response — this shape is for a future success-code 200 lookup
// from a dashboard island.
export const AlertTrendEmpty = z.object({
  status: z.literal('not_ready'),
});
export type AlertTrendEmpty = z.infer<typeof AlertTrendEmpty>;

// Canonical home for these schemas is the sibling `./alert-comments.ts`;
// re-export from here so the brief's `src/lib/contracts/alerts.ts` path
// resolves to the same schemas. Importers that need the inferred
// `AlertCommentItem` TYPE should pull it directly from
// './alert-comments' (where the source module declares both the zod
// value and its `z.infer` alias under that name).
export {
  AlertCommentCreateBody,
  AlertCommentItem,
  AlertCommentList,
} from './alert-comments';

// POST body for /api/alerts/[id]/resolve. The endpoint takes an optional
// `note` (≤ 500 chars) which the route stamps onto `Alert.closingNote`
// on the same write that flips `status → 'resolved'`. Note is OPTIONAL
// (NOT `.min(1)`) — a blank resolve is fully valid and stored as NULL.
// Trimmed server-side so a UI that posts `'   '` gets the same empty
// handling as a literal-empty string. The VARCHAR(500) DB cap echoes the
// upper bound so a malformed client that bypasses zod hits an INSERT-
// level rejection rather than stamping a multi-column note. `.strict()`
// keeps drift contained: an unexpected field on a future caller 400s
// through rather than silently accepting arbitrary keys (parity with
// AlertFalsePositiveBody and the prior empty-body schema).
export const AlertResolveBody = z
  .object({
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type AlertResolveBody = z.infer<typeof AlertResolveBody>;
export type AlertResolveBodyInput = z.input<typeof AlertResolveBody>;

// Unified detail-view status mutation. The status-specific arms keep
// false-positive reasons required and only allow an optional close note
// for resolved alerts. `snoozed` is intentionally absent because snooze is
// derived from `snoozedUntil`, not persisted as an AlertStatus.
export const AlertStatusMutationBody = z.discriminatedUnion('status', [
  z.object({ status: z.literal('open') }).strict(),
  z.object({ status: z.literal('in_progress') }).strict(),
  z.object({ status: z.literal('resolved'), note: z.string().trim().max(500).optional() }).strict(),
  z
    .object({
      status: z.literal('false_positive'),
      reason: z.string().trim().min(1).max(500),
    })
    .strict(),
]);
export type AlertStatusMutationBody = z.infer<typeof AlertStatusMutationBody>;

// Served by POST /api/alerts/[id]/resolve. Slim quintuple — the route
// ratifies the new server-authoritative timestamps + close-stamp trio:
//   - `id` / `status` / `statusChangedAt` / `acknowledgedAt` mirror the
//     prior envelope (acknowledgedAt is nullable because it stays null
//     until triage fires).
//   - `closedAt`, `closedBy`, `closingNote` are the close-stamp trio
//     stamped at the same time `status` flips to `resolved`.
//     `closedAt`/`closedBy` are stamped ONCE on the FIRST transition
//     and preserved across re-resolves. `closingNote` is the trimmed
//     optional note (1–500 chars; null on a blank note).
// Idempotent — re-resolve returns the same closing trio without
// firing an UPDATE.
export const AlertResolveResponse = z.object({
  id: z.string(),
  status: AlertStatus,
  statusChangedAt: z.string().nullable(),
  acknowledgedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  closedBy: z.string().nullable(),
  closingNote: z.string().nullable(),
  // Reopen-stamp trio — stamped onto the same write that flips
  // status → 'open' via /api/alerts/[id]/reopen, AND surfaced on the
  // same envelope echo so the client's optimistic flip + parent
  // refetch see the trio without a second round trip. All three
  // fields are nullable — `reopenedAt` is set once on the FIRST
  // transition away from a `resolved` / `false_positive` state and
  // preserved across re-reopens; the idempotent "already-open"
  // branch keeps the trio as it was on disk; a blank reopen
  // stamps `reopenReason: null`.
  reopenedAt: z.string().nullable(),
  reopenedBy: z.string().nullable(),
  reopenReason: z.string().nullable(),
});
export type AlertResolveResponse = z.infer<typeof AlertResolveResponse>;

// Authoritative status + lifecycle snapshot returned by the unified
// detail-view status mutation. Snooze remains a separate stored timestamp.
export const AlertStatusMutationResponse = AlertResolveResponse.extend({
  falsePositiveReason: z.string().nullable(),
  snoozedUntil: z.string().nullable(),
});
export type AlertStatusMutationResponse = z.infer<typeof AlertStatusMutationResponse>;

// POST body for /api/alerts/resolve. The bulk-resolve endpoint takes a
// non-empty `ids` array plus an OPTIONAL shared `note` (≤ 500 chars
// after trim) which the route stamps onto `Alert.closingNote` for every
// row that flips to 'resolved' on the same transaction. `ids` is `.min(1)`
// so an empty selection 400s through — there is no empty-selection write
// path on the bulk route (the page-side gesture already drops empty
// submissions, but the schema enforces it server-side too so a future
// non-React caller can't bypass it). `note` is OPTIONAL (NOT `.min(1)`)
// — a blank resolve is valid and stored as NULL on every row in the
// batch. Trimmed server-side so a UI that posts `'   '` gets the same
// empty handling as a literal-empty string. The VARCHAR(500) DB cap
// echoes the upper bound so a malformed client bypassing zod hits an
// INSERT-level rejection rather than stamping a multi-column note.
// `.strict()` keeps drift contained: a future caller field 400s through
// rather than silently accepting arbitrary keys (parity with
// AlertResolveBody / AlertFalsePositiveBody / AlertReopenBody).
export const AlertBulkResolveBody = z
  .object({
    ids: z.array(z.string().min(1)).min(1),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type AlertBulkResolveBody = z.infer<typeof AlertBulkResolveBody>;
export type AlertBulkResolveBodyInput = z.input<typeof AlertBulkResolveBody>;

// Served by POST /api/alerts/resolve. Re-uses the AlertResolveResponse
// envelope PER row so the page's optimistic flip + future refetch share
// the same wire shape as the single-id route — the bulk response is
// structurally a `{results: AlertResolveResponse[]}`-shaped map of the
// single-id envelope. The route stamps the result per id (including
// already-resolved rows that were silently skipped) so the helper's
// outcome map can derive `'ok'` / `'err'` per id without a second round
// trip. `results` order mirrors the request `ids` order to keep
// mapping deterministic.
export const AlertBulkResolveResponse = z.object({
  results: z.array(AlertResolveResponse),
});
export type AlertBulkResolveResponse = z.infer<typeof AlertBulkResolveResponse>;

// POST body for /api/alerts/resolve-batch. Sister to
// `AlertBulkResolveBody` but with three deltas driven by the bulk
// popover on /alerts:
//
//   - `ids` is a non-empty array of alert ids (`.min(1)` so an empty
//     selection 400s through; there is no empty-selection write path
//     on the bulk route, mirroring the snooze-batch / resolve-batch /
//     remediate-batch companions).
//   - `note` is OPTIONAL, 0–2000 chars after trim. The 2000-char cap
//     aligns with `AlertNote.body`'s `AlertNoteCreateBody` max (see
//     `src/lib/contracts/alert-notes.ts`) because the bulk path stamps
//     the resolution as an AlertNote row per resolved alert (the
//     route's `prisma.$transaction` fans out an AlertNote.create per
//     row alongside the Alert.update). Blank/whitespace-only collapses
//     to "no AlertNote created" so a click without a typed note
//     still flips `status: 'resolved'` without leaving an empty
//     breadcrumb on every row's notes pane.
//   - `.strict()` keeps drift contained: an undisclosed caller field
//     400s through rather than silently accepting arbitrary keys
//     (parity with AlertBulkResolveBody / AlertBulkSnoozeBody /
//     AlertBulkRemediateBody).
export const AlertBulkResolveBatchBody = z
  .object({
    ids: z.array(z.string().min(1)).min(1),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();
export type AlertBulkResolveBatchBody = z.infer<typeof AlertBulkResolveBatchBody>;
export type AlertBulkResolveBatchBodyInput = z.input<typeof AlertBulkResolveBatchBody>;

// Slim per-row envelope served by POST /api/alerts/resolve-batch.
// Extends `AlertResolveResponse`'s close-stamp trio into a narrow
// wire shape so the bulk fan-out's optimistic flip and a follow-up
// refetch see the same column family. Mirrors `AlertItem`'s
// `status` / `statusChangedAt` posture AND the `closedAt` /
// `closedBy` nullable close-stamp posture so a flag-on-resolved row
// in the indicator strip matches a fresh /api/alerts refetch 1:1.
// `closingNote` is intentionally OMITTED from the slim shape — the
// bulk path stamps `closingNote` via the Alert row when a note is
// supplied, but the slim row does NOT carry it (the bulk page-side
// helper optimistically writes NULL on a blank note and the typed
// Note on a non-blank one; the detail-page `closingNote` cell reads
// off the parent Alert envelope on a subsequent refetch rather than
// the bulk-route response itself).
export const AlertBulkResolveBatchRow = z
  .object({
    id: z.string(),
    status: AlertStatus,
    statusChangedAt: z.string().nullable(),
    closedAt: z.string().nullable(),
    closedBy: z.string().nullable(),
  })
  .strict();
export type AlertBulkResolveBatchRow = z.infer<typeof AlertBulkResolveBatchRow>;

// Served by POST /api/alerts/resolve-batch. `results` order mirrors
// the post-scope `liveIds` order so the helper's per-id outcome map
// can derive `'ok'` / `'err'` from set lookups without re-sorting.
// `.min(0)` allows an empty results array (every id was cross-team
// or future-snoozed — surgical scope-check drop, no transaction
// write, no envelope entry).
export const AlertBulkResolveBatchResponse = z.object({
  results: z.array(AlertBulkResolveBatchRow).min(0),
});
export type AlertBulkResolveBatchResponse = z.infer<typeof AlertBulkResolveBatchResponse>;

// POST body for /api/alerts/[id]/false-positive. Required text
// (1–500 chars inclusive — excludes the 0-char "empty reason" branch
// AND the 501-char overflow). Trimmed server-side so a UI that posts
// "   " gets the same 400 as a literal empty string — a whitespace
// stamp is invisible on the row chip and silently degrades the
// operator's audit trail. The VARCHAR(500) DB cap echoes the upper
// bound so a malformed client that bypasses zod hits an INSERT-level
// rejection rather than stamping a multi-column reason. `.strict()` so
// an unexpected future caller field 400s through rather than silently
// accepting arbitrary keys (parity with AlertResolveBody).
export const AlertFalsePositiveBody = z
  .object({
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type AlertFalsePositiveBody = z.infer<typeof AlertFalsePositiveBody>;
export type AlertFalsePositiveBodyInput = z.input<typeof AlertFalsePositiveBody>;

// Served by POST /api/alerts/[id]/false-positive. Reuses the resolve
// envelope's id/status/statusChangedAt/acknowledgedAt quartuple
// (the FP write stamps statusChangedAt and may stamp acknowledgedAt
// too) AND adds the reason that the row's chip subtitle reads. The
// dedicated response (vs. in-place extending AlertResolveResponse)
// keeps the resolve / reopen handlers from having to round-trip a
// nullable string they never write.
export const AlertFalsePositiveResponse = AlertResolveResponse.extend({
  falsePositiveReason: z.string().nullable(),
});
export type AlertFalsePositiveResponse = z.infer<typeof AlertFalsePositiveResponse>;

// POST body for /api/alerts/[id]/reopen. The endpoint takes an
// optional `reason` (≤ 500 chars trimmed) which the route stamps
// onto `Alert.reopenReason` on the same write that flips
// `status → 'open'`. Reason is OPTIONAL — a blank reopen is fully
// valid and `reopenReason` stores NULL on the row. The VARCHAR(500)
// cap echoes the upper bound so a malformed client bypassing zod
// hits an INSERT-level rejection rather than stamping a
// multi-column reason. `.strict()` keeps drift contained: an
// unexpected field on a future caller 400s through rather than
// silently accepting arbitrary keys (parity with `AlertResolveBody`
// and `AlertFalsePositiveBody`).
export const AlertReopenBody = z
  .object({
    reason: z.string().trim().max(500).optional(),
  })
  .strict();
export type AlertReopenBody = z.infer<typeof AlertReopenBody>;
export type AlertReopenBodyInput = z.input<typeof AlertReopenBody>;

// PATCH body for /api/alerts/[id]/remediate. The endpoint takes an
// EXPLICIT `set` discriminator — `'now'` stamps `Alert.remediatedAt`
// with the server-side `new Date()` (the caller's optimistic Date.toISOString()
// is overwritten by the server-authoritative stamp on persist), and
// `'clear'` sets the column back to null. The set-then-clear symmetry
// keeps the handler idempotent on a stale click: a re-remediate on
// an already-stamped row lands the existing envelope without an UPDATE
// (preserves the original stamp), and a re-clear on a non-stamped row
// returns the same envelope without an UPDATE.
//
// Discriminated union over `z.literal('now' | 'clear')` so a future
// caller field 400s through with a typed error rather than silently
// accepting arbitrary keys (parity with `AlertResolveBody` /
// `AlertReopenBody`). `.strict()` per arm keeps the body shape narrow.
export const AlertRemediateBody = z.discriminatedUnion('set', [
  z.object({ set: z.literal('now') }).strict(),
  z.object({ set: z.literal('clear') }).strict(),
]);
export type AlertRemediateBody = z.infer<typeof AlertRemediateBody>;
export type AlertRemediateBodyInput = z.input<typeof AlertRemediateBody>;

// Slim envelope served by PATCH /api/alerts/[id]/remediate — just the
// new server-authoritative stamp. Echoes the row's id + the freshly-
// written remediatedAt so the caller's optimistic flip can reconcile.
// Mirrors `AlertItem`'s `remediatedAt: z.string().nullable()` posture
// exactly so the parent detail envelope and the per-row write response
// share the same column shape.
export const AlertRemediateResponse = z.object({
  id: z.string(),
  remediatedAt: z.string().nullable(),
});
export type AlertRemediateResponse = z.infer<typeof AlertRemediateResponse>;

// POST body for /api/alerts/remediate-batch. Non-empty `ids` array
// (`.min(1)` so an empty selection 400s through — there is no empty-
// selection write path on the bulk route, mirroring the snooze /
// resolve / false-positive / reopen companions). No `duration` /
// `until` / `set` arm: the bulk action is a unit-less "stamp now";
// the caller's per-row writer on /alerts/[id] remains the canonical
// `set: 'now' | 'clear'` affordance (the bulk path is forward-only
// — clearing is a single-row gesture on the detail page). `.strict()`
// keeps drift contained: an unexpected caller field 400s through
// rather than silently accepting arbitrary keys (parity with
// AlertBulkSnoozeBody / AlertBulkResolveBody / AlertResolveBody).
export const AlertBulkRemediateBody = z
  .object({
    ids: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type AlertBulkRemediateBody = z.infer<typeof AlertBulkRemediateBody>;
export type AlertBulkRemediateBodyInput = z.input<typeof AlertBulkRemediateBody>;

// Slim row envelope served by POST /api/alerts/remediate-batch.
// Mirrors `AlertRemediateResponse` exactly so the helper's
// optimistic flip and any future refetch share the same column
// shape as the single-id route — `{id, remediatedAt}` per row.
// `remediatedByEmail` is NOT included here: the slim wire shape
// stays narrow (the bulk path stamps it server-side authoritatively
// and the parent list envelope reads it back via a follow-up fetch
// to /api/alerts AFTER the all-OK optimistic flip; the helper
// optimistically mirrors `callerEmail` onto the item list so the
// chip stack matches the server-stamped value without the round
// trip). `.strict()` keeps drift contained: an unexpected field
// on a future caller 400s through rather than silently accepting
// arbitrary keys.
export const AlertBulkRemediateRow = z
  .object({
    id: z.string(),
    remediatedAt: z.string().nullable(),
  })
  .strict();
export type AlertBulkRemediateRow = z.infer<typeof AlertBulkRemediateRow>;

// Per-id failure envelope inside POST /api/alerts/remediate-batch.
// Slim `{id, error}` so the route does not have to round-trip a
// verbose error tree. `not_owner` is the only typed failure the bulk
// route emits today — the per-id owner gate short-circuits and
// pushes into this arm rather than 404'ing the whole batch, so the
// page's per-row outcome map distinguishes not_owner (operator
// doesn't own the row) from a 404 (row missing / cross-team).
// Cross-team ids are SILENTLY DROPPED from this envelope (mirrors
// the snooze-batch posture: they're filtered above the owner gate,
// not surfaced here). Future widening — e.g. a `raced` arm for an
// update that lost to a concurrent write — is a literal-union widen
// on `error`.
export const AlertBulkRemediateFail = z
  .object({
    id: z.string(),
    error: z.enum(['not_owner']),
  })
  .strict();
export type AlertBulkRemediateFail = z.infer<typeof AlertBulkRemediateFail>;

// Served by POST /api/alerts/remediate-batch. The envelope carries
// two arrays so the page's per-row outcome map (via
// runBulkRemediate) can distinguish a successful stamp from a
// not-owner rejection without falling back to a blanket 404:
//
//   - `results` — every row the route stamped (idempotent-already-
//     stamped rows AND newly-stamped rows). Slim `{id, remediatedAt}`
//     per row, mirroring `AlertBulkSnoozeRow` / `AlertRemediateResponse`
//     so the bulk wire stays narrow and a future refetch against
//     /api/alerts reads the same column shape end-to-end.
//   - `failed` — every row the per-id owner gate rejected.
//
// Both arrays ordered to mirror the post-scope `liveIds` order so
// the helper's per-id outcome map can derive 'ok' / 'err' from set
// lookups without re-sorting. `.min(0)` allows both arrays empty
// (an empty working set after scope + owner filtering).
export const AlertBulkRemediateResponse = z.object({
  results: z.array(AlertBulkRemediateRow).min(0),
  failed: z.array(AlertBulkRemediateFail).min(0),
});
export type AlertBulkRemediateResponse = z.infer<typeof AlertBulkRemediateResponse>;

// Body served by POST /api/alerts/ownership-batch — the bulk "Take
// ownership" gesture on /alerts. Sister to AlertBulkSnoozeBody /
// AlertBulkRemediateBody but with two subtly different semantics:
//
//   - `ids` is a non-empty array of alert ids (`.min(1)` so an empty
//     selection 400s through; the page-side handler pre-filters
//     already-owned rows so the schema enforces it server-side too).
//   - The route does NOT take an `ownerId` (or any FK) in the body
//     — the assignment target is the resolved caller
//     `WorkspaceMember.id` from `requireTeamRole('member') ctx`, so
//     there is no attacker-controlled id to validate. The shape
//     mirrors `AlertBulkSnoozeBody` / `AlertBulkRemediateBody` for
//     API surface parity.
//   - `.strict()` so an undisclosed caller field 400s through. Drift
//     containment matches every other bulk body: an unexpected key
//     is rejected at the schema layer instead of silently accepted.
export const AlertBulkOwnershipBody = z
  .object({
    ids: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type AlertBulkOwnershipBody = z.infer<typeof AlertBulkOwnershipBody>;
export type AlertBulkOwnershipBodyInput = z.input<typeof AlertBulkOwnershipBody>;

// Slim per-row envelope for the freshly-owned rows branch of POST
// /api/alerts/ownership-batch response — a transfer that actually
// wrote a new `Alert.ownerId`. Mirrors the on-screen column shape
// `{id, ownerId, ownerName}` so the helper's optimistic flip on
// `items` can mirror the server-authoritative ownerName directly
// without a refetch. `ownerName` is null when the resolved
// `User.name` is missing — the route's peer-read tolerates a null
// route mirror, so the page's chip stack degrades to "unknown
// owner" without a follow-up round trip. `.strict()` keeps drift
// contained: an unexpected field on a future caller 400s through
// rather than silently accepting arbitrary keys.
export const AlertBulkOwnershipRow = z
  .object({
    id: z.string(),
    ownerId: z.string(),
    ownerName: z.string().nullable(),
  })
  .strict();
export type AlertBulkOwnershipRow = z.infer<typeof AlertBulkOwnershipRow>;

// Per-id conflict envelope for the already-owned branch of POST
// /api/alerts/ownership-batch response — a row whose `ownerId`
// already equals the caller WorkspaceMember id. The route skips
// the UPDATE (the assignment is a no-op) and reports the skip via
// this arm. The page's helper pre-filter drops already-owned ids
// from the candidate set so a typical bulk-take selection never
// produces conflicts; a stale post-mount reassignment race surfaces
// here. Slim `{id, ownerId}` so the route does not have to round-
// trip a verbose error tree — the FK is the existing `ownerId` the
// route couldn't re-stamp, so the response carries the same FK the
// caller already knows. `.strict()` keeps drift contained.
export const AlertBulkOwnershipConflict = z
  .object({
    id: z.string(),
    ownerId: z.string(),
  })
  .strict();
export type AlertBulkOwnershipConflict = z.infer<typeof AlertBulkOwnershipConflict>;

// Served by POST /api/alerts/ownership-batch. Envelope carries
// two arrays so the page's per-id outcome map (via
// runBulkTakeOwnership) can distinguish a successful transfer from
// an already-owned skip without falling back to a blanket error:
//   - `results` — every row the route stamped a fresh `ownerId` ON
//     (slim {id, ownerId, ownerName} per row, mirroring the list
//     endpoint's column shape end-to-end so the optimistic flip
//     reads the FK directly from the envelope).
//   - `conflicts` — every row the per-id already-owned gate
//     skipped; reported as a soft idempotent branch (HTTP 200), NOT
//     409 — the operator-facing UX treats "you already own this"
//     as a no-op success, not a failure.
//
// Both arrays ordered to mirror the post-scope `liveIds` order so
// the helper's per-id outcome map can derive 'ok' / 'err' from set
// lookups without re-sorting. `.min(0)` allows both arrays empty
// (an empty working set after scope filtering — e.g. every id
// cross-team drops the response to `{results: [], conflicts: []}`
// with HTTP 200).
export const AlertBulkOwnershipResponse = z.object({
  results: z.array(AlertBulkOwnershipRow).min(0),
  conflicts: z.array(AlertBulkOwnershipConflict).min(0),
});
export type AlertBulkOwnershipResponse = z.infer<typeof AlertBulkOwnershipResponse>;

// POST body for /api/alerts/assign-owner-batch — the bulk
// "Assign owner…" gesture on /alerts selected rows. Sister to
// `AlertBulkOwnershipBody` (the "Take ownership" bulk, which
// resolves ownership target from the caller's session) but with
// two explicitly different semantics:
//
//   - The body MUST carry an explicit `ownerId` (or `null` for the
//     "Unassigned" arm). The route validates the FK against the
//     caller's workspace — same posture as PATCH /api/alerts/[id]
//     /owner (cross-team ids rejected with 400 + field error,
//     because the input came from a picker the caller just
//     rendered). `null` clears the FK on every row, mirroring the
//     single-id picker's "Unassigned" arm.
//   - `ids` is `.min(1)` so the schema enforces the "no
//     empty-selection write path" invariant server-side too.
//
// `.strict()` keeps drift contained: an undisclosed caller field
// 400s through rather than silently accepting arbitrary keys
// (parity with `AlertBulkOwnershipBody` / `AlertBulkSnoozeBody` /
// `AlertBulkResolveBody`).
export const AlertBulkAssignOwnerBody = z
  .object({
    ids: z.array(z.string().min(1)).min(1),
    ownerId: z.string().nullable(),
  })
  .strict();
export type AlertBulkAssignOwnerBody = z.infer<typeof AlertBulkAssignOwnerBody>;
export type AlertBulkAssignOwnerBodyInput = z.input<typeof AlertBulkAssignOwnerBody>;

// Served by POST /api/alerts/assign-owner-batch. Slim — the
// `{results: AlertBulkAssignOwnerRow[]}` envelope carries one row
// per id the route actually stamped. Cross-team ids AND rows with
// a future `snoozedUntil` (the "snooze arm" — see the route
// comment) are silently dropped; their absence from `results` is
// the success-side signal. The per-row envelope re-uses
// `AlertBulkOwnershipRow` verbatim — `{id, ownerId, ownerName}`
// — so list + detail + every bulk owner-write surface share
// exactly one column shape end-to-end (a future widening of any
// one widens all of them through this single zod literal).
// `.min(0)` allows an empty results array (every id was
// cross-team / snoozed / dedup'd).
export const AlertBulkAssignOwnerResponse = z.object({
  results: z.array(AlertBulkOwnershipRow).min(0),
});
export type AlertBulkAssignOwnerResponse = z.infer<typeof AlertBulkAssignOwnerResponse>;

// Per-alert lifecycle event served by GET /api/alerts/[id]/activity.
// v1 emits one event per row that has ever been reopened:
//   - `id: 'reopen'` — the event kind; future expansion (resolve,
//     FP, owner-change) is a mid-cycle refactor that introduces a
//     literal-union `id` and per-kind schema. For now v1 ships the
//     reopen-only shape because no row can carry more than one
//     reopen event in scope-resolved alerts.
//   - `at` — ISO-8601 wall clock of the re-open, stamped off
//     `Alert.reopenedAt`.
//   - `actorId` — User.id of the operator who flipped the row back
//     to `open`, OR null on a stale row whose actor's User is gone.
//   - `actorName` — best-effort `User.name` resolved via a single
//     batched `User.findMany` peer-read on /api/alerts/[id]/activity
//     (mirrors the `ownerName` resolution on /api/alerts/[id]).
//   - `reason` — the optional 0–500-char `Alert.reopenReason` row,
//     preserved verbatim on already-open rows (idempotent branch
//     doesn't churn the value).
export const AlertActivityItem = z.object({
  id: z.literal('reopen'),
  at: z.string(),
  actorId: z.string().nullable(),
  actorName: z.string().nullable(),
  reason: z.string().nullable(),
});
export type AlertActivityItem = z.infer<typeof AlertActivityItem>;

export const AlertActivityList = z.object({
  items: z.array(AlertActivityItem),
  // Cursor for the next page. v1 always stamps `null` — most rows
  // in scope-resolved alerts carry zero events and a row that
  // ever-reopened carries exactly one event. A future expansion
  // (resolve / FP / owner events) widens the schema and re-introduces
  // a real cursor; the response shape is locked here so the call
  // site never has to widen it.
  nextCursor: z.string().nullable(),
});
export type AlertActivityList = z.infer<typeof AlertActivityList>;

// Served by GET /api/alerts/asset-options — chip-list source for the
// /alerts page's asset chip row. Distinct assets on the team, ordered
// by frequency desc with name asc as the tiebreak. The wire shape is
// intentionally narrow (name + count) so the chip row's API surface
// doesn't carry severity breakdowns it never renders. The count is
// "alerts this asset has on the team right now" — same scope as
// /api/assets (`teamId` server-seeded, `findingId: { not: 'manual' }`).
//
// `name` shape is the composite `${host}:${port}/${protocol}` — same
// shape the `/alerts?asset=…` deep-link from /assets-table already
// produces (`assets-table.tsx:70`). `count` lets the row render a
// numeric suffix mirroring the severity chip's per-tier badges (a
// future addition per the brief — optional today).
export const AssetFilterOption = z.object({
  name: z.string(),
  count: z.number().int().nonnegative(),
});
export const AssetFilterOptions = z.object({
  items: z.array(AssetFilterOption),
});
export type AssetFilterOption = z.infer<typeof AssetFilterOption>;
export type AssetFilterOptions = z.infer<typeof AssetFilterOptions>;
