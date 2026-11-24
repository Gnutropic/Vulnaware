// @polsia:user-owned — `loadDashboardSummary(teamId, memberId, now)` for
// GET /api/dashboard/summary. Server-only: imports `server-only`,
// `prisma`, and `sinceToBoundDate`. The route layer (src/app/api/dashboard/
// summary) is the ONLY caller. Never called from a Server Component,
// page body, or layout (data-plane rule).
//
// Four `prisma.alert.count` calls — one per tile when a roster row exists — are scoped
// strictly to `teamId` so a tampered URL cannot surface another team's
// counts (the route seeds `teamId` from `workspaceContext.workspaceId`
// above; this selector trusts that narrow). All four predicates
// hit existing composite indexes on `prisma/schema/alerts.prisma`:
//
//   - `status: { in: ['open', 'in_progress'] }` → @@index([teamId, status])
//   - `ownerId: memberId`         → @@index([teamId, ownerId])
//   - `snoozedUntil: { gt: now }` → @@index([teamId, snoozedUntil])
//   - `status: 'resolved'` +
//     `closedAt: { gte: bound }`  → @@index([teamId, status])
//                                   (status-saturated prefix; the
//                                    closedAt gte is the narrower)
//
// `now` is injectable to keep the selector pure for tests; callers
// from route handlers rely on the default `new Date()`.
//
// The four counts are independent — `Promise.all` them into one
// round trip. Each is a no-args aggregate that returns a single
// integer; no join interpolation, no row post-processing.

import 'server-only';
import { sinceToBoundDate } from '@/lib/business/alerts-since';
import { prisma } from '@/lib/db';

export interface DashboardSummaryCounts {
  open: number;
  ownedByMe: number;
  snoozed: number;
  resolvedThisWeek: number;
}

export async function loadDashboardSummary(
  teamId: string,
  memberId: string | null,
  now: Date = new Date(),
): Promise<DashboardSummaryCounts> {
  // Shared 7d bound for the "Resolved this week" tile. Re-uses the
  // same `sinceToBoundDate('7d')` call the /api/alerts route uses so
  // the operator never sees a tile count drift from the /alerts page
  // window edge.
  const resolvedSince = sinceToBoundDate('7d', now);

  // Independent peer reads — `Promise.all` to fire-and-collect in one
  // round-trip window. Each `count` is a typed non-negative integer
  // returning promise (Prisma serializes the count to a number).
  const [open, ownedByMe, snoozed, resolvedThisWeek] = await Promise.all([
    // `Unresolved alerts` — both lifecycle states that are not yet
    // resolved or marked false-positive. Snoozed rows remain included:
    // this tile is an unresolved-state summary, not an action queue.
    prisma.alert.count({ where: { teamId, status: { in: ['open', 'in_progress'] } } }),
    // `Owned by me` — rows the caller owns across ALL states. An
    // event the caller resolved yesterday still counts because the
    // operator wants to see "work I was responsible for" alongside
    // "work I'm actively triaging".
    memberId ? prisma.alert.count({ where: { teamId, ownerId: memberId } }) : Promise.resolve(0),
    // `Snoozed` — live snooze state. The INVERSE of the /api/alerts
    // hide-snoozed default: `snoozedUntil > now` means the row is
    // still silenced. Elapsed snoozes (`<= now`) are NOT counted so
    // a stale 7d-old snooze doesn't inflate the tile.
    prisma.alert.count({ where: { teamId, snoozedUntil: { gt: now } } }),
    // `Resolved this week` — `status: 'resolved'` AND
    // `closedAt >= now - 7d`. Uses the same 7d window so the tile
    // semantically matches the /alerts "Last 7d" chip.
    prisma.alert.count({
      where: { teamId, status: 'resolved', closedAt: { gte: resolvedSince } },
    }),
  ]);

  return {
    open,
    ownedByMe,
    snoozed,
    resolvedThisWeek,
  };
}
