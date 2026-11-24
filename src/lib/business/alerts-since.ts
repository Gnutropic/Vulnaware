// @polsia:user-owned — Trailing-N-days time-window helpers for the /alerts
// chip row + the /api/alerts route.
//
// The chip exposes a "Last 7d" toggle that narrows the visible row set
// to alerts whose `createdAt` OR the more-recent of `{createdAt,
// statusChangedAt}` falls inside the window. The route plugs this into
// Prisma via a composite OR clause:
//
//   { OR: [
//     { createdAt: { gte: sinceBound } },
//     { statusChangedAt: { gte: sinceBound } },
//   ] }
//
// This module houses the BOTH the wire-side pieces that route uses:
// the bound date (a value the route's `gte` can receive) AND the
// predicate (a pure function a unit test can call without spinning up
// Prisma) — same semantics, two surfaces. The bound date IS the route's
// `gte`. The predicate IS the same `gte` evaluation the DB applies,
// callable from a Node test.
//
// Composition posture: the predicate is "max(createdAt, statusChangedAt)
// >= sinceBound". The chip's URL key is `since=7d`. Pure helpers —
// no Prisma, no `server-only`, safe to call from a route handler OR
// from a test.

export const SINCE_PRESETS = ['7d', '30d', '90d'] as const;
export type SincePreset = (typeof SINCE_PRESETS)[number];

export type SinceFilter = '7d' | null;

// Inclusive lower-bound `Date` for a `since` preset. `now - days *
// 86_400_000` mirrors the page.tsx date-input slice semantics so a
// freshly-mounted tab and an active preset always agree on what "Last
// 7d" means — a chip click within a few seconds of writing the page's
// own ranges yields a window the same width.
//
// `now` is injectable to keep the helper pure for tests; callers in
// route handlers rely on the default `new Date()`.
export function sinceToBoundDate(since: SincePreset, now: Date = new Date()): Date {
  const days = since === '7d' ? 7 : since === '30d' ? 30 : 90;
  return new Date(now.getTime() - days * 86_400_000);
}

// Pure row predicate: a row matches the chip window when at least ONE
// of its timestamps is `>= sinceBound`. The route's Prisma OR clause
// applies the same `gte` against both columns, so a freshly resolved
// row whose `createdAt` is older than the window but whose
// `statusChangedAt` (or `createdAt` on a brand-new row) sits inside
// the window still surfaces.
//
// `statusChangedAt` may be `null` (rows that have not transitioned) —
// for those, only the `createdAt` arm can match; the predicate treats
// `null` as "not in the window" so a true OR over both arms stays
// equivalent to the SQL semantics.
export function matchesSinceWindow(
  row: { createdAt: Date; statusChangedAt: Date | null },
  sinceBound: Date,
): boolean {
  if (row.createdAt >= sinceBound) return true;
  if (row.statusChangedAt != null && row.statusChangedAt >= sinceBound) return true;
  return false;
}
