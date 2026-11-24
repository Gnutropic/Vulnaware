// @polsia:user-owned — Wire contracts for GET /api/dashboard/summary and
// GET /api/dashboard/recent-activity. Pure zod (no server-only / db imports)
// so both the route handler AND the client islands share the same
// validation + the same inferred types.
//
// Two envelopes stamped here:
//   - `DashboardSummary` — the four tile counts on the post-login
//     dashboard (Unresolved alerts / Owned by me / Snoozed / Resolved this week),
//     scanned by /api/dashboard/summary via four `prisma.alert.count`
//     calls (one per predicate, all index-only on existing
//     `@@index([teamId, status|ownerId|snoozedUntil])`).
//   - `DashboardActivityItem` + `DashboardRecentActivity` — the
//     recent-activity feed below the stat row, capped at 8 events.
//     The per-event union is a discriminated union by `kind`
//     (`created | resolved | reopened`) so a future expansion
//     (false-positive, owner-change) widens the schema without
//     collapsing the existing client switch.
//
// The contract for /api/alerts/[id]/activity (`AlertActivityItem` with
// `id: 'reopen'` literal) is intentionally NOT reused here — it
// serves a per-row introspection surface that emits at most one
// event per row. The dashboard feed is a cross-row timeline that may
// emit multiple events per row (resolve + reopen inside the window),
// so the schemas are parallel (mirroring the existence of separate
// `examples` + `audit-events` contracts where each fits its
// resource).
//
// Cursor posture: `DashboardRecentActivity.nextCursor` is always
// `null` in v1 (cursor field reserved for a future expansion to a
// real paginated timeline). Same posture as
// `AlertActivityList.nextCursor` at src/lib/contracts/alerts.ts:660.
//
// Ten envelopes stamped here, all read by
// `src/components/custom/dashboard/*` islands:
//   - `DashboardSummary`           → GET /api/dashboard/summary
//   - `DashboardRecentActivity`    → GET /api/dashboard/recent-activity
//   - `DashboardOpenAging`         → GET /api/dashboard/aging
//   - `DashboardTrend`             → GET /api/dashboard/trend (last
//                                    14d alert volume; raw event list
//                                    bucketed by the client into local
//                                    days — server never buckets so a
//                                    non-UTC caller never sees a
//                                    silently-rounded chart).
//   - `DashboardTopAssets`         → GET /api/dashboard/top-assets
//   - `DashboardRecentRemediations`→ GET /api/dashboard/recent-remediations
//                                    (last 5 alerts with non-null
//                                    `Alert.remediatedAt`, scoped to
//                                    `teamId`, ordered by `remediatedAt
//                                    desc`, excluding future-snoozed
//                                    rows; future-snoozed exclusion
//                                    mirrors the /api/alerts hide-
//                                    snoozed posture 1:1 so the tile
//                                    never shows a row the operator has
//                                    explicitly silenced).
//   - `DashboardOpenBySeverityCounts` → GET /api/dashboard/open-by-severity
//                                    (open alerts grouped by severity
//                                    for the /dashboard "Open by severity"
//                                    tile; counts are coalesced so unknown
//                                    / null severities collapse to 'low'
//                                    to match /api/alerts's chip-row
//                                    posture).
//   - `DashboardScanCoverage`       → GET /api/dashboard/scan-coverage
//                                    (the "Scan coverage" tile: three
//                                    summary numbers — `totalHosts`,
//                                    `hostsWithOpenAlerts`, and the
//                                    team's freshest contributing
//                                    `lastScanActivityAt` stamp —
//                                    derived from the same underlying
//                                    `Alert.finding.asset.host` shape
//                                    as /api/assets, but a parallel
//                                    read so the /api/assets page-size
//                                    cap (200) never truncates the
//                                    team-wide rollup).
//   - `DashboardMttr`              → GET /api/dashboard/mttr
//                                    ("Mean time to remediate" tile:
//                                    arithmetic mean of
//                                    `(Alert.remediatedAt -
//                                    Alert.createdAt)` across the team's
//                                    remediated rows inside two rolling
//                                    30-day windows — current and prior
//                                    — so the delta direction + magnitude
//                                    is server-stamped and the client
//                                    only owns the arrow / unit
//                                    formatting).
//   - `DashboardTopCves`           → GET /api/dashboard/top-cves
//                                    ("Top recurring CVEs" tile: top 5
//                                    CVE identifiers ranked by total
//                                    occurrence across currently-open
//                                    AND recently-remediated (last 7d)
//                                    alerts on the caller's team, with
//                                    a per-row severity mix and a deep-
//                                    link to `/alerts?q=<CVE>` using
//                                    the existing query-param
//                                    convention; manual-alert rows are
//                                    skipped because a manual row's
//                                    `finding.cveId` is unrelated to a
//                                    real CVE identifier).

import { z } from 'zod';

// Four tile counts. Each is a non-negative integer — server-stamped
// from a `prisma.alert.count({ where: { teamId, ... } })` peer-read
// over the team's rows. The route uses `teamId` from
// `ctx.membership.teamId` server-side so the tile counts are scoped
// to the caller's team on every read; a tampered URL cannot surface
// counts from another team's alerts.
//
//   - `open`             — unresolved rows in `status: 'open'` or
//                          `status: 'in_progress'` at any owner. The
//                          response field remains `open` for wire
//                          compatibility with the existing dashboard.
//   - `ownedByMe`        — rows the caller owns across ALL states
//                          (not narrowed by status). An event the
//                          caller resolved yesterday still counts;
//                          it just shows "you were responsible".
//   - `snoozed`          — rows whose `snoozedUntil` is still in the
//                          future (INVERSE of the /api/alerts
//                          hide-snoozed default). Elapsed snoozes do
//                          NOT count; the tile mirrors the live
//                          snooze state, not the historical count.
//   - `resolvedThisWeek` — rows in `status: 'resolved'` whose
//                          `closedAt >= now - 7d`. Re-uses
//                          `alerts-since.ts`'s
//                          `sinceToBoundDate('7d')` helper so the
//                          same window edge as the /alerts "Last 7d"
//                          chip — operator never sees a tile count
//                          drift from the page.
export const DashboardSummary = z.object({
  open: z.number().int().nonnegative(),
  ownedByMe: z.number().int().nonnegative(),
  snoozed: z.number().int().nonnegative(),
  resolvedThisWeek: z.number().int().nonnegative(),
});
export type DashboardSummary = z.infer<typeof DashboardSummary>;

// One lifecycle event in the dashboard "Recent activity" feed.
// Discriminated union by `kind` so the client can `switch(event.kind)`
// on the row without re-validating per-kind payload shape. Each
// branch carries:
//   - `at` / `actorId` / `actorName` — shared metadata stamp.
//     `at` is an ISO-8601 wall clock of the event
//     (createdAt for `created`, closedAt for `resolved`, reopenedAt
//     for `reopened`). `actorId` is the User.id of the operator who
//     caused the event — `null` on a row where the column is null
//     (manual / pre-trio rows for `created`, FP-without-actor rows
//     for `resolved`). `actorName` is the best-effort `User.name`
//     resolution via a single batched `prisma.user.findMany` peer-read
//     (mirror of /api/alerts/[id]/activity's actor resolution).
//     Falls back to `null` on a stale User row.
//   - `reason` — optional 0–500-char operator note. Present on
//     `resolved` (`closingNote`) and `reopened` (`reopenReason`)
//     events; absent on `created` (the schema literally stamps
//     `null`).
//   - `alertId` / `alertTitle` / `severity` / `cveId` — context
//     fragment so the row can be rendered without a follow-up
//     alert-detail fetch. `alertTitle` is the row's `source`
//     column falling back to the row's `cveId` when no richer
//     title is available (the route stamps `alertTitle: cveId`
//     on cold-start rows whose CveEntry is not yet ingested).
//     `severity` is the free-form string column — `null` on rows
//     pre-dating the column.
//
// The shared metadata is hoisted into a base schema so per-kind
// branches only declare their `kind` + their `reason`-bearing stamp;
// common fields aren't repeated across the three branches.
const DashboardActivityBase = z.object({
  at: z.string(),
  actorId: z.string().nullable(),
  actorName: z.string().nullable(),
  reason: z.string().nullable(),
  alertId: z.string(),
  alertTitle: z.string(),
  severity: z.string().nullable(),
  cveId: z.string(),
});

export const DashboardActivityItem = z.discriminatedUnion('kind', [
  DashboardActivityBase.extend({
    kind: z.literal('created'),
    // `created` events have no operator-stamped reason — the row
    // is born from an ingested finding, not from a UI action. The
    // shared `reason: z.string().nullable()` on `DashboardActivityBase`
    // carries `null` naturally; no override needed.
  }),
  DashboardActivityBase.extend({
    kind: z.literal('resolved'),
  }),
  DashboardActivityBase.extend({
    kind: z.literal('reopened'),
  }),
]);
export type DashboardActivityItem = z.infer<typeof DashboardActivityItem>;

// Envelope for GET /api/dashboard/recent-activity. Capped at 8 events
// server-side — the schema's `.max(8)` mirrors the route's hard cap
// so a server drift (anything > 8 items) fails the parse loudly
// instead of silently overflowing the layout.
//
// `nextCursor` is ALWAYS `null` in v1 (cursor reserved for future
// expansion). Same posture as `AlertActivityList.nextCursor`.
export const DashboardRecentActivity = z.object({
  items: z.array(DashboardActivityItem).max(8),
  nextCursor: z.string().nullable(),
});
export type DashboardRecentActivity = z.infer<typeof DashboardRecentActivity>;

// Four-bucket age distribution for currently `Open` alerts on the
// post-login dashboard. Each bucket is a non-negative integer count
// of rows in `status: 'open'` whose `createdAt` falls inside the
// named window. Bucket edges (server-stamped from
// `now = new Date()` by `loadOpenAlertAging`):
//
//   - `le7d`    — createdAt >= now - 7d           (0–7 days old)
//   - `d8to30`  — now - 30d <= createdAt < now - 7d   (8–30 days old)
//   - `d31to90` — now - 90d <= createdAt < now - 30d  (31–90 days old)
//   - `gt90d`   — createdAt < now - 90d           (>90 days old)
//
// Bucket overlap is impossible: upper-bound is strict (`lt`), lower-
// bound is inclusive (`gte`), so a single boundary instant belongs to
// exactly one bucket. A team legitimately may have zero open alerts
// across all four buckets on a brand-new install — `.nonnegative()`
// (not `.positive()`) matches `DashboardSummary`'s posture 1:1 so a
// zero is a valid (non-loading) value.
//
// All four bounds are computed server-side from a single
// `now = new Date()` so the four buckets always sum to (or are less
// than, given the in-flight-creation race) the `Open` tile's count
// from GET /api/dashboard/summary. UI bucket counts and the
// `Open` tile are NEVER derived from different `now` values.
export const DashboardOpenAging = z.object({
  le7d: z.number().int().nonnegative(),
  d8to30: z.number().int().nonnegative(),
  d31to90: z.number().int().nonnegative(),
  gt90d: z.number().int().nonnegative(),
});
export type DashboardOpenAging = z.infer<typeof DashboardOpenAging>;

// Envelope for GET /api/dashboard/trend. The server returns the RAW
// event rows that fall inside the last 14d window — the CLIENT
// buckets into local days on its side. Why server-doesn't-bucket:
//
//   - The brief calls for "local day" buckets. Server-side bucketing
//     would have to pick a timezone (typically UTC) and silently lie
//     to any caller outside that zone — a user in UTC+09 would see
//     their Sunday work attributed to Monday.
//   - The route stamp is a single `prisma.alert.findMany` with
//     `OR: [{ createdAt: { gte: windowStart } }, { closedAt:
//     { gte: windowStart } }]`. Each row carries exactly the fields
//     the client needs (`id`, `createdAt`, `closedAt`) and nothing
//     more — narrow select, no joins, bounded `take: 5000`.
//
// `closedAt` is the raw `null | ISO` because a row that has never
// resolved emits no resolve event for any local day; the client
// counts `createdAt` only for those rows. The 5000-event hard cap
// is widened (vs the 8-event activity cap) because an event-stream
// trend chart inherently pulls every event in the window, not just
// the latest few. If a team's 14-day volume legitimately exceeds
// this, the route silently truncates and the chart's max-bar Y is
// the truncation's domain — flagged in the selector header.
export const DashboardTrend = z.object({
  events: z
    .array(
      z.object({
        id: z.string(),
        createdAt: z.string(),
        closedAt: z.string().nullable(),
      }),
    )
    .max(5000),
});
export type DashboardTrend = z.infer<typeof DashboardTrend>;

// Envelope for GET /api/dashboard/top-assets — the "Top affected
// assets (open alerts)" tile on the post-login /dashboard. One row
// per ranked `Asset.host` (raw hostname, NOT the composite
// `${host}:${port}/${protocol}`; the client re-decorates each link
// with the per-host `(port, protocol)` from the separately-fetched
// `/api/alerts/asset-options` chip source so the deep-link round-
// trips byte-for-byte with the chip-row's wire identity).
//
// "Open" predicate (the loader documents it 1:1): status NOT IN
// {resolved, false_positive} AND snooze-window inactive
// (`snoozedUntil IS NULL OR snoozedUntil <= now`). `in_progress`
// rows count here; a row whose status is `open` but whose snooze is
// still active is suppressed.
//
// Score + ordering:
//   - `score`        = sum of severity-ordinals across every open alert
//                      at that host (critical = 4, high = 3, medium = 2,
//                      low = 1) — `severity` is the free-form string
//                      column on Alert, so the ordinal map lowercases
//                      + falls back to 0 on an unknown / null value.
//                      Stamped on the wire but NOT a rank key — the
//                      tile ranks by raw count so a high-volume
//                      low-severity host is never outranked by a
//                      low-volume critical host at the same node.
//   - `dominantSeverity` = the highest ordinal-tier present at that
//                      host (`null` when no severity-bearing rows
//                      survived the reduce; rare).
//   - sort         = `count` desc → `host` asc
//                      (stable alpha tiebreak; matches the
//                      asset-options route's alpha-tiebreak posture).
//
// Hard-cap posture: `.max(10)` mirrors the route's slice-to-10 hard
// cap (per the brief's 5–10 range) so a server drift (>10 items)
// fails the parse loudly instead of silently overflowing the card.
const TopAssetSeverity = z.enum(['critical', 'high', 'medium', 'low']);
export const DashboardTopAssetItem = z.object({
  host: z.string().min(1).max(253),
  count: z.number().int().nonnegative(),
  dominantSeverity: TopAssetSeverity.nullable(),
  score: z.number().nonnegative(),
});
export type DashboardTopAssetItem = z.infer<typeof DashboardTopAssetItem>;

export const DashboardTopAssets = z.object({
  items: z.array(DashboardTopAssetItem).max(10),
});
export type DashboardTopAssets = z.infer<typeof DashboardTopAssets>;

// One row in the "Recent remediations" tile — the last 5 alerts on
// the caller's team with a non-null `Alert.remediatedAt`, ordered by
// `remediatedAt` desc, with future-snoozed rows excluded (mirror of
// the /api/alerts hide-snoozed posture so a row the operator has
// explicitly silenced never surfaces in this tile). Each row
// carries enough wire-state for the client island to render the
// full row without a follow-up alert-detail fetch:
//   - `id`          — `Alert.id`; the link target back into
//                     /alerts/[id].
//   - `title`       — best-effort finding-title stamp. The loader
//                     prefers the joined `VulnerabilityFinding.cveId`
//                     (a real `CVE-YYYY-NNNN` literal) and falls back
//                     to the row's free-form `source` column when no
//                     richer title is available (manual rows whose
//                     finding has not rolled into the cve-feed yet).
//                     1–512 chars; never empty so the client always
//                     has a label to render.
//   - `ownerEmail` — the assignee's best-effort `User.email`
//                     resolution. `null` on rows where the owner has
//                     not yet linked a `User` account, on stale
//                     WorkspaceMember rows, or when the row has no
//                     assignee at all. The client renders the literal
//                     `Unassigned` on a null so the visible row never
//                     shows a bare "—".
//   - `remediatedAt` — the ISO-8601 string stamp of the row's
//                     `Alert.remediatedAt`. Drives the visible
//                     relative-time stamp ("3 minutes ago") and the
//                     hover-title absolute stamp.
export const DashboardRecentRemediationItem = z.object({
  id: z.string(),
  title: z.string().min(1).max(512),
  ownerEmail: z.string().nullable(),
  remediatedAt: z.string(),
});
export type DashboardRecentRemediationItem = z.infer<typeof DashboardRecentRemediationItem>;

// Envelope for GET /api/dashboard/recent-remediations. The schema's
// `.max(5)` mirrors the loader's slice-to-5 hard cap so a server
// drift (>5 items) fails the parse loudly instead of silently
// overflowing the card.
//
// Future-snooze exclusion rationale (per the loader header): a row
// with `snoozedUntil > now` is operator-silenced and therefore
// does NOT surface in this tile — matches the /api/alerts hide-
// snoozed default so an operator never sees a row they've muted
// appear in the "recently resolved" feed. The exclusion is
// enforced via an OR branch in the loader's `where: { ... }`
// (see `src/lib/business/dashboard-recent-remediations.ts`).
//
// Empty-state contract: a team with no remediated alerts returns
// `{ items: [] }` cleanly — `.max(5)` accepts 0. The client renders
// the copy `"No remediations yet."` for that case.
export const DashboardRecentRemediations = z.object({
  items: z.array(DashboardRecentRemediationItem).max(5),
});
export type DashboardRecentRemediations = z.infer<typeof DashboardRecentRemediations>;

// Four-severity open-alert counts for the post-login dashboard
// "Open by severity" tile. Mirrors `DashboardSummary`'s
// `.nonnegative()` posture so a zero is a valid (non-loading)
// value on a brand-new team. Severity is coalesced on the wire
// to the four canonical literals (critical|high|medium|low); an
// unknown / null row severity columns collapse to 'low' so a
// legacy row never crashes the tile or the deep-link. The
// (critical → high → medium → low) order matches the chip-row
// emitter at `src/lib/business/alerts-severity.ts`, so a
// permalink from a click lands on the /alerts view with the
// matching severity chip already active. Tile-side predicate
// (status='open' AND remediatedAt IS NULL AND OR[snoozedUntil
// IS NULL, snoozedUntil <= now]) intentionally excludes
// remediated-but-still-status=open rows; the /alerts click-
// through URL does NOT filter on remediated, so a remediated-
// but-still-open row may contribute to the click-through view
// even though it is not reflected in the tile count.
export const DashboardOpenBySeverityCounts = z.object({
  critical: z.number().int().nonnegative(),
  high: z.number().int().nonnegative(),
  medium: z.number().int().nonnegative(),
  low: z.number().int().nonnegative(),
});
export type DashboardOpenBySeverityCounts = z.infer<typeof DashboardOpenBySeverityCounts>;

// Envelope for GET /api/dashboard/scan-coverage — the "Scan coverage"
// tile on the post-login /dashboard. Three summary numbers in one round
// trip:
//   - `totalHosts`           — distinct `Alert.finding.asset.host`
//                              count for the team, scope identical to
//                              /api/assets' host-only reduce
//                              (`findingId: { not: 'manual' }` so
//                              manual rows never contribute an
//                              undefined host).
//   - `hostsWithOpenAlerts`  — sub-count: number of those hosts whose
//                              `openCount >= 1` in the same reduce.
//                              Severity is intentionally NOT weighted;
//                              the brief specifies "hosts with at least
//                              one open alert", full stop.
//   - `lastScanActivityAt`   — ISO-8601 of the MAX of every contributing
//                              alert's "freshest stamp" via the team-
//                              scoped peer helper
//                              `computeAlertLastActivityAtForList`
//                              (same helper /api/assets already calls).
//                              `null` when no contributing alert
//                              produces a stamp (a team with zero
//                              matching alerts); never falls back to
//                              `Alert.createdAt` so the wire posture
//                              stays identical to /api/assets's
//                              `lastActivityAt: string | null` shape.
//
// All three counts are scoped server-side to `ctx.membership.teamId`
// — a URL-tampered `teamId` is irrelevant because the route does not
// read it.
//
// Empty-state contract: a team with zero contributing alerts returns
// `{ totalHosts: 0, hostsWithOpenAlerts: 0, lastScanActivityAt: null }`
// cleanly. `.nonnegative()` matches the rest of the dashboard family
// so a zero is a valid (non-loading) value on a brand-new install.
export const DashboardScanCoverage = z.object({
  totalHosts: z.number().int().nonnegative(),
  hostsWithOpenAlerts: z.number().int().nonnegative(),
  lastScanActivityAt: z.string().nullable(),
});
export type DashboardScanCoverage = z.infer<typeof DashboardScanCoverage>;

// Envelope for GET /api/dashboard/mttr — the "Mean time to remediate"
// tile on the post-login /dashboard. Three server-stamped numbers
// back the single downward-pointing-per-row link out to the resolved-
// alerts view:
//
//   - `mttrMs`        — arithmetic mean (in milliseconds) of
//                       `(Alert.remediatedAt − Alert.createdAt)`
//                       across the team's rows where
//                       `remediatedAt is not null` AND
//                       `windowStart ≤ remediatedAt < windowEnd`
//                       (current 30d window). `null` on a window with
//                       zero remediated rows — a brand-new install
//                       renders `"—”` instead of a fabricated `0d`.
//                       The arithmetic is performed in JavaScript over
//                       the rows the loader returned — Prisma has no
//                       general-purpose `AVG(timestamptz_diff)` aggregate,
//                       and computing in DB would couple the wire shape
//                       to a Postgres-specific function the route can't
//                       round-trip cleanly.
//   - `priorMttrMs`   — same shape for the prior 30-day baseline
//                       window (`now-60d ≤ remediatedAt < now-30d`).
//                       `null` on a window with zero prior remediated
//                       rows — a workspace that only started resolving
//                       alerts this month has no baseline yet, so the
//                       subtitle renders `"no prior baseline"` (the
//                       delta direction is undefined, NEVER
//                       fabricated). The prior window is stamped from
//                       the SAME `now = new Date()` as the current
//                       window so the two windows are always adjacent
//                       and never overlap.
//   - `sampleSize`    — non-negative integer count of remediated rows
//                       in the CURRENT window (NOT both windows
//                       summed). The headline reads `"3.2 days (over 12
//                       alerts)"` once `sampleSize < 5` so a single-
//                       alert sample never silently misleads — the
//                       client formats the qualifier, the server
//                       proves the count.
//
// Server-stamped delta posture: the route does NOT expose a boolean
// `isImproving` / `deltaMs` wire field — the client derives both
// from `mttrMs` and `priorMttrMs` directly so the unit formatting
// (`"3.2 days"` / `"4.1 h"` / `"12 min"`) collapses to ONE
// formatter, not two. The ±5% "no change" copy threshold is also a
// client formatting concern, not a server predicate.
//
// `mttrMs` is in milliseconds (not seconds / days) so the JS-side
// formatter can bucket any magnitude — seconds, minutes, hours,
// days, or longer — without a unit-conversion shape change. Half-
// rounding (`Math.round`) caps the wire value to ms precision; a
// workspace's typical MTTR is far above 1 ms so a 1 ms loss is well
// below the rendering precision.
//
// Remediation-event scope (the loader header documents it 1:1):
// `"remediatedAt" only`. A row qualifies when
// `remediatedAt IS NOT NULL AND remediatedAt >= windowStart`.
// Looser readings (`MAX(remediatedAt, closedAt, reopenedAt)`)
// would inflate the metric with reopen→close cycles that don't
// qualify as remediation and would diverge from the existing
// "Recent remediation activity" tile (which keys on the same
// `remediatedAt` stamp).
export const DashboardMttr = z.object({
  mttrMs: z.number().nullable(),
  priorMttrMs: z.number().nullable(),
  sampleSize: z.number().int().nonnegative(),
});
export type DashboardMttr = z.infer<typeof DashboardMttr>;

// Envelope for GET /api/dashboard/top-cves — the "Top recurring CVEs"
// tile on the post-login /dashboard. One row per ranked `cveId`
// (the joined `VulnerabilityFinding.cveId`; manual-source rows are
// skipped because a manual row's `finding.cveId` is unrelated to a
// real CVE identifier). The total `count` is unweighted — each
// contributing row counts 1 regardless of its severity — and the
// per-tier `mix` counters let the client sub-format the
// `n critical · n high · …` sub-line from a single wire shape.
//
// Severity coalescence: `Alert.severity` is the free-form string
// column so an unknown / null value collapses to `'low'` (same
// posture as the rest of the dashboard family and /api/alerts's
// chip-row coalescer at `src/lib/business/alerts-severity.ts`).
// `dominantSeverity` is the highest ordinal-tier present in the mix
// for that cveId — `null` when no severity-bearing rows contributed
// (essentially never in practice; kept nullable for symmetry with
// `DashboardTopAssetItem.dominantSeverity`).
//
// Sort + slice: `count` desc → `cveId` asc (stable alpha tiebreak,
// mirror of `DashboardTopAssets` posture). Slice to top 5
// server-side. `.max(5)` on `DashboardTopCves.items` fails the parse
// loudly on any server drift above the cap.
//
// `cveId` is 1-64 chars — covers `CVE-YYYY-NNNN[N…X]` up through
// the canonical CVE-prefix range. The `mix` object ALWAYS returns
// all four tiers (zero entries allowed) so the client renders the
// dominant badge + the per-tier sub-mix in a single round trip
// without a follow-up fill.
//
// Empty-state contract: a team with zero contributing alerts
// returns `{ items: [] }` cleanly — `.max(5)` accepts 0. The
// client renders the copy `"No recurring CVEs in the last 7 days."`
// for that case.
const DashboardTopCveSeverity = z.enum(['critical', 'high', 'medium', 'low']);
const DashboardTopCveSeverityMix = z.object({
  critical: z.number().int().nonnegative(),
  high: z.number().int().nonnegative(),
  medium: z.number().int().nonnegative(),
  low: z.number().int().nonnegative(),
});

export const DashboardTopCveItem = z.object({
  cveId: z.string().min(1).max(64),
  count: z.number().int().nonnegative(),
  dominantSeverity: DashboardTopCveSeverity.nullable(),
  mix: DashboardTopCveSeverityMix,
});
export type DashboardTopCveItem = z.infer<typeof DashboardTopCveItem>;

export const DashboardTopCves = z.object({
  items: z.array(DashboardTopCveItem).max(5),
});
export type DashboardTopCves = z.infer<typeof DashboardTopCves>;

// Envelope for GET /api/dashboard/top-cves-by-epss — the "Top open CVEs
// by EPSS" tile on the post-login /dashboard. Distinct from
// `DashboardTopCves` above: scope is currently-open alerts only
// (`status: { in: ['open','in_progress'] }` with a hide-snoozed
// branch), rank key is `epssScore` desc, and each row carries the
// affected-asset count (not the count of contributing alerts).
//
// Per-row shape:
//   - `cveId`              — joined `VulnerabilityFinding.cveId`.
//                            Manual-source rows are skipped because
//                            a manual row's `finding.cveId` is
//                            unrelated to a real `CVE-…` literal.
//   - `epssScore`          — the canonical EPSS percentile pulled
//                            off `VulnerabilityFinding.epssScore`
//                            (0..1, where 1 = 100%). The score is
//                            sent raw so server-side ranking operates
//                            on a single, unrounded number — the
//                            client multiplies by 100 + rounds for
//                            display. `null` when the contributing
//                            finding has no EPSS stamp; in that case
//                            the row would only appear in the
//                            ranking IF every other contributing cveId
//                            also lacks a stamp (rare; the selector
//                            groups on cveId so it still surfaces a
//                            reduced row).
//   - `dominantSeverity`   — highest ordinal severity present in the
//                            contributing findings for this cveId
//                            (the `VulnerabilityFinding.severity`
//                            column is the free-form string; an
//                            unknown / null value collapses to
//                            `'low'` to match the rest of the
//                            dashboard family's chip-row coalescer
//                            at `src/lib/business/alerts-severity.ts`).
//                            `null` only when no severity-bearing
//                            contributing row survived, which by
//                            construction cannot happen.
//   - `affectedAssetCount` — distinct host count across all of the
//                            cveId's contributing findings, deduped
//                            via a `Set<host>` so re-scans of the
//                            same host don't inflate the visible
//                            stamp. `0` (not-null `.nonnegative()`)
//                            is a valid (non-loading) value on a
//                            freshly-observed CVE whose asset has
//                            not yet been re-stamped.
//
// Sort + slice posture: `epssScore` desc → `dominantSeverity`
// ordinal desc (critical > high > medium > low tiebreak) → `cveId`
// asc (stable alpha tiebreak). Slice to top 8 server-side so the
// card visually anchors consistently with the existing top-5
// tiles AND has room for the brief's 5–10 range. `.max(8)` on
// `DashboardTopCvesByEpss.items` fails the parse loudly on any
// server drift above the cap.
//
// Empty-state contract: a team with zero currently-open alerts
// (or a team whose open alerts all belong to manual-source rows
// that are dropped) returns `{ items: [] }` cleanly — `.max(8)`
// accepts 0. The client renders the copy `"No open CVEs with EPSS
// data."` for that case.
const DashboardTopCveByEpssSeverity = z.enum(['critical', 'high', 'medium', 'low']);
export const DashboardTopCveByEpssItem = z.object({
  cveId: z.string().min(1).max(64),
  epssScore: z.number().min(0).max(1).nullable(),
  dominantSeverity: DashboardTopCveByEpssSeverity.nullable(),
  affectedAssetCount: z.number().int().nonnegative(),
});
export type DashboardTopCveByEpssItem = z.infer<typeof DashboardTopCveByEpssItem>;

export const DashboardTopCvesByEpss = z.object({
  items: z.array(DashboardTopCveByEpssItem).max(8),
});
export type DashboardTopCvesByEpss = z.infer<typeof DashboardTopCvesByEpss>;
