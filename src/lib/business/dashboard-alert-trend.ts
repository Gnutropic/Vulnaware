// @polsia:user-owned — `loadDashboardAlertTrend(teamId, now, hardCap)`
// for GET /api/dashboard/trend. Server-only: imports `server-only` +
// `prisma`. The route layer (src/app/api/dashboard/trend) is the
// ONLY caller. Never called from a Server Component, page body, or
// layout (data-plane rule).
//
// Strategy: ONE `prisma.alert.findMany` over the union of two
// lifecycle-event arms (`createdAt >= windowStart`, `closedAt >=
// windowStart`) where `windowStart = now - 14d`. Each row carries
// exactly the three fields needed (`id`, `createdAt`, `closedAt`)
// — narrow select, no joins, bounded `take`.
//
// The CLIENT (`dashboard-trend-chart.tsx`) buckets the raw row list
// into 14 LOCAL days on the user's wall-clock. The server never
// buckets — bucketing server-side would round to UTC and silently
// lie to any caller outside UTC. This is the same "server returns
// raw events, client buckets" posture noted in
// `DashboardTrend`'s contract header.
//
// No `status` filter on the resolve arm — the event-stream
// posture matches `loadDashboardRecentActivity`'s:
//   - Resolve events are stamped at `closedAt` regardless of the
//     row's later/current `status`. A row that resolved on day 5
//     and then re-opened on day 9 still emits a `Resolved` event
//     for day 5 (the fact that the row has since re-opened does
//     not retroactively erase the resolve).
//   - Without the `status` filter, the trend chart and the recent
//     activity feed agree on what a "resolve event" means across
//     the same `/dashboard` surface.
//
// `now` and `hardCap` are injectable to keep the selector pure
// for tests. The default cap is 5000 events — flagged as a trade-
// off in the brief: a team with runaway volume in a 14d window
// silently truncates, and the chart's Y-max reflects the truncated
// data, not the true daily peak.

import 'server-only';
import { prisma } from '@/lib/db';

const MS_PER_DAY = 86_400_000;
const DEFAULT_HARD_CAP = 5000;

export interface DashboardAlertTrendEvent {
  id: string;
  createdAt: Date;
  closedAt: Date | null;
}

export async function loadDashboardAlertTrend(
  teamId: string,
  now: Date = new Date(),
  hardCap: number = DEFAULT_HARD_CAP,
): Promise<{ events: DashboardAlertTrendEvent[] }> {
  // 14-day inclusive lower bound. The bound is a single `now -
  // 14 * MS_PER_DAY` — mirrors the slug-style presets in
  // `alerts-since.ts` but computed inline so the route layer
  // doesn't widen the public preset surface for a single
  // consumer.
  const windowStart = new Date(now.getTime() - 14 * MS_PER_DAY);
  const cappedTake = Math.max(1, Math.min(DEFAULT_HARD_CAP, Math.floor(hardCap)));

  // Single OR'd findMany — each arm has a composite index on
  // `(teamId, <ts>)` so Postgres plans via the lowest-cardinality
  // arm and Bitmap-ORs the rest. The opened arm uses
  // `@@index([teamId, createdAt(sort: Desc)])` (existing on
  // alerts.prisma); the resolved arm falls back to a per-team
  // filter, which is acceptable for a 14-day window. Bounded
  // `take` keeps the wire move bounded regardless of team
  // cardinality.
  const rows = await prisma.alert.findMany({
    where: {
      teamId,
      OR: [{ createdAt: { gte: windowStart } }, { closedAt: { gte: windowStart } }],
    },
    select: {
      id: true,
      createdAt: true,
      closedAt: true,
    },
    take: cappedTake,
  });

  return {
    events: rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      closedAt: r.closedAt,
    })),
  };
}
