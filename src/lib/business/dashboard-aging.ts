// @polsia:user-owned — `loadOpenAlertAging(teamId, now)` for GET
// /api/dashboard/aging. Server-only: imports `server-only` +
// `prisma`. The route layer (src/app/api/dashboard/aging) is the
// ONLY caller; never called from a Server Component, page body, or
// layout (data-plane rule).
//
// Four parallel `prisma.alert.count` calls — one per age bucket —
// each scoped strictly to `teamId` and `status: 'open'` so a tampered
// URL cannot surface another team's distribution. The route seeds
// `teamId` from `workspaceContext.workspaceId` above; this selector trusts
// that narrow. All four predicates hit existing composite indexes
// on `prisma/schema/alerts.prisma`:
//
//   - `status: 'open'` (literal)             → @@index([teamId, status])
//   - `createdAt: { gte: bound }` / `{ lt: bound }`
//                                            → @@index([teamId, createdAt(sort: Desc)])
//
// Bucket overlap is impossible:
//   - le7d    : createdAt >= now - 7d
//   - d8to30  : now - 30d <= createdAt < now - 7d
//   - d31to90 : now - 90d <= createdAt < now - 30d
//   - gt90d   : createdAt < now - 90d
//
// Lower-bound is inclusive (`gte`), upper-bound is strict (`lt`) so a
// single boundary instant belongs to exactly one bucket.
//
// `now` is injectable to keep the selector pure for tests; callers
// from route handlers rely on the default `new Date()`. The four
// counts are independent — fire them in one round-trip window via
// `Promise.all`. Each is a typed non-negative integer aggregate;
// no join interpolation, no row post-processing.

import 'server-only';
import { prisma } from '@/lib/db';

export interface OpenAlertAgingCounts {
  le7d: number;
  d8to30: number;
  d31to90: number;
  gt90d: number;
}

// One day's worth of milliseconds, kept as a named constant so a
// future tuning of the bucket boundaries (e.g. shifting the GT 90d
// cap to 120d) only changes the literal here.
const MS_PER_DAY = 86_400_000;

export async function loadOpenAlertAging(
  teamId: string,
  now: Date = new Date(),
): Promise<OpenAlertAgingCounts> {
  // Pre-compute the four bucket boundaries from a single `now` so the
  // route's response and the UI's "Open" tile (which is stamped from
  // the same `new Date()` window on the same mount) are guaranteed to
  // agree on bucket edges. Using `getTime()` arithmetic keeps the
  // computation off the Date prototype's slow path.
  const d7 = new Date(now.getTime() - 7 * MS_PER_DAY);
  const d30 = new Date(now.getTime() - 30 * MS_PER_DAY);
  const d90 = new Date(now.getTime() - 90 * MS_PER_DAY);

  // Independent peer reads — `Promise.all` to fire-and-collect in one
  // round-trip window. Each `count` is a typed non-negative integer
  // returning promise (Prisma serializes the count to a number).
  const [le7d, d8to30, d31to90, gt90d] = await Promise.all([
    // `≤ 7d` — inclusive lower bound (`gte`), no upper bound. Rows
    // created today and rows created up to seven days ago both count.
    prisma.alert.count({
      where: { teamId, status: 'open', createdAt: { gte: d7 } },
    }),
    // `8–30d` — strict upper bound (`lt`) on the 7d edge so a row
    // whose `createdAt` lands exactly on `now - 7d` falls into `≤7d`,
    // not here. Inclusive lower bound (`gte`) on the 30d edge keeps
    // the 30-day cutoff inclusive of day 30.
    prisma.alert.count({
      where: {
        teamId,
        status: 'open',
        createdAt: { gte: d30, lt: d7 },
      },
    }),
    // `31–90d` — strict upper bound (`lt`) on the 30d edge so a row
    // whose `createdAt` lands exactly on `now - 30d` is already
    // counted in `8–30d` (per the inclusive-lower-edge posture
    // above), not here. Inclusive lower bound (`gte`) on the 90d
    // edge keeps day 90 IN this bucket so a row created exactly
    // `now - 90d` ago falls in here rather than in the `>90d`
    // overflow — same day-90 placement a `>90d = createdAt <
    // now - 90d` predicate already enforces.
    prisma.alert.count({
      where: {
        teamId,
        status: 'open',
        createdAt: { gte: d90, lt: d30 },
      },
    }),
    // `> 90d` — open rows older than 90d. Strict upper bound (`lt
    // now - 90d`) so a row whose `createdAt` lands exactly on
    // `now - 90d` is counted in `31–90d` (per the inclusive-lower
    // edge of that bucket above), not here. Using `lte` would
    // double-count the boundary row.
    prisma.alert.count({
      where: {
        teamId,
        status: 'open',
        createdAt: { lt: d90 },
      },
    }),
  ]);

  // Return shape wire-matched to `DashboardOpenAging` so the route can
  // `DashboardOpenAging.parse(...)` it directly. The four counts
  // are guaranteed disjoint across the (now - 90d, now] window — a
  // single `prisma.alert.count` per bucket plus the disjoint
  // predicates means bucket overlap is impossible.
  return { le7d, d8to30, d31to90, gt90d };
}
