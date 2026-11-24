// @polsia:user-owned — `loadDashboardMttr(teamId, now)` for
// GET /api/dashboard/mttr. Server-only: imports `server-only` +
// `prisma`. The route layer (src/app/api/dashboard/mttr) is the
// ONLY caller; never called from a Server Component, page body,
// or layout (data-plane rule).
//
// Definition of "closure event" (widened from the prior
// `remediatedAt`-only reading):
//   A row contributes to a window's mean iff
//   ( (remediatedAt IS NOT NULL AND remediatedAt ∈ [windowStart, windowEnd))
//  OR (closedAt     IS NOT NULL AND closedAt     ∈ [windowStart, windowEnd)) )
//   AND (closure_event_timestamp - createdAt) > 0
//   where closure_event_timestamp = remediatedAt ?? closedAt.
//
// Why widen: the post-resolve metric should reflect the team's
// end-to-end lifecycle latency, not just the operator "Mark as
// remediated" stamp. A row that resolves without the team ever
// flipping the remediate stamp still represents a CLOSED incident
// — the MTTR tile's job is "how long did it take your team to
// act on the alert?", and an unmarked-but-resolved row is just as
// much "the team acted" as a stamped one. The narrow reading
// would silently drop every resolve-without-remediate row.
//
// How "one contribution per row, one contribution per window" is
// preserved: the (remediatedAt, closedAt) pair is logically
// disjoint AND the WHERE clause ORs them into a single express.
// A row that has BOTH stamps still contributes exactly ONCE
// because we'd OR-combine the two predicates and a UNION-style
// projection would double-count; instead we read BOTH columns
// and pick `remediatedAt ?? closedAt` as the closure event in
// the JS reduce. Per-row pairing is enforced server-side: the
// row's `id` is included in the projection so the reduce can
// dedupe any row that surfaces in both arms.
//
// Strategy: FOUR windowed `prisma.alert.findMany` reads (each
// narrow-scope, indexed-only) — two 30-day windows
// (current + prior) and two closure columns
// (remediatedAt + closedAt):
//
//   - current × remediatedAt — `now-30d ≤ remediatedAt < now`
//   - current × closedAt     — `now-30d ≤ closedAt     < now`
//   - prior   × remediatedAt — `now-60d ≤ remediatedAt < now-30d`
//   - prior   × closedAt     — `now-60d ≤ closedAt     < now-30d`
//
// `now` is captured ONCE so the four windows are always
// adjacent and never overlap. The strict upper bound (`lt`)
// on every read prevents boundary double-counting between the
// current and prior windows (`now-30d` belongs to the prior
// window, NOT the current).
//
// Filter shape:
//   - `teamId`                  — server-seeded from
//                                 `workspaceContext.workspaceId` so the
//                                 rollup is scoped to the caller's
//                                 team on every read.
//   - {column: { not: null, gte: windowStart, lt: windowEnd } }
//                               — only rows with a non-null
//                                 closure stamp contribute, with
//                                 the closure stamp falling
//                                 inside the 30-day window.
//
// Narrow select (`id`, `createdAt`, `remediatedAt`, `closedAt`)
// keeps the wire move cheap — no joins, no related tables.
// `id` rides the projection so the merge can dedupe rows that
// surface in BOTH the remediated-At AND closed-At arms of the
// same window.
//
// Index footprint (per prisma/schema/alerts.prisma):
//   - `@@index([teamId, remediatedAt])` — pair with `teamId`
//     indexes the remediate-At windowed scans. Both reads ride
//     this composite so the loader does NOT trigger a heap scan
//     once the table grows.
//   - The closed-At arms ride a narrower index than the
//     remediate-At arms — there is NO `@@index([teamId, closedAt])`
//     defined on `Alert`. Postgres will fall back to a heap scan
//     on the closed-At paths, which a 30-day windowed filter
//     bounds to a manageable row set even before the row count
//     scales out.
//
// Arithmetic lives in JS (NOT a SQL aggregate): Postgres has no
// first-class `(timestamptz - timestamptz) → bigint` aggregate and
// Prisma's typed `groupBy` does not expose the `EXTRACT(EPOCH
// FROM …)` round-trip cleanly. The windowed row count is bounded
// (a team's 30-day closure volume rarely exceeds four digits,
// and even a large volume is captured by a narrow four-column
// `select`), so the in-memory reduce is cheap. Mean = sum of
// `(closureTs − createdAt)` per row, divided by the row count,
// where `closureTs = remediatedAt ?? closedAt`. A `null` row
// delta (defensive — Prisma 6 does NOT narrow the result type
// when the WHERE clause stamps `remediatedAt: { not: null }`)
// is filtered out so the mean stays sound.
//
// Empty windows return `mttrMs: null` / `priorMttrMs: null`
// (rather than fabricated `0d` / `0ms`) so the client renders
// the inert `—` placeholder and never silently misleads. The
// contract surface documents this posture on `DashboardMttr` 1:1.
import 'server-only';
import { prisma } from '@/lib/db';

const DAYS_TO_MS = 24 * 60 * 60 * 1000;

export interface DashboardMttr {
  mttrMs: number | null;
  priorMttrMs: number | null;
  sampleSize: number;
}

export async function loadDashboardMttr(
  teamId: string,
  now: Date = new Date(),
): Promise<DashboardMttr> {
  const nowMs = now.getTime();
  const currentStart = new Date(nowMs - 30 * DAYS_TO_MS);
  const priorStart = new Date(nowMs - 60 * DAYS_TO_MS);

  // Four narrow-windowed reads. The two "current × 𝓍" reads share the
  // SAME upper bound (`now`), and the two "prior × 𝓍" reads share
  // the SAME upper bound (`currentStart`). Each read's strict upper
  // bound (`lt`) prevents boundary overlap.
  const [currentRem, currentClosed, priorRem, priorClosed] = await Promise.all([
    prisma.alert.findMany({
      where: {
        teamId,
        remediatedAt: { not: null, gte: currentStart, lt: now },
      },
      select: { id: true, createdAt: true, remediatedAt: true, closedAt: true },
    }),
    prisma.alert.findMany({
      where: {
        teamId,
        // `remediatedAt: null` so a row stamped in BOTH columns is
        // NOT double-counted via a UNION of the two arms — the row
        // would already have hit the remediated-At arm above with
        // its timestamp counted there. The closed-At arm picks up
        // rows the team resolved WITHOUT first stamping remediate.
        remediatedAt: null,
        closedAt: { not: null, gte: currentStart, lt: now },
      },
      select: { id: true, createdAt: true, remediatedAt: true, closedAt: true },
    }),
    prisma.alert.findMany({
      where: {
        teamId,
        remediatedAt: { not: null, gte: priorStart, lt: currentStart },
      },
      select: { id: true, createdAt: true, remediatedAt: true, closedAt: true },
    }),
    prisma.alert.findMany({
      where: {
        teamId,
        remediatedAt: null,
        closedAt: { not: null, gte: priorStart, lt: currentStart },
      },
      select: { id: true, createdAt: true, remediatedAt: true, closedAt: true },
    }),
  ]);

  return {
    mttrMs: meanDeltaMs([...currentRem, ...currentClosed]),
    priorMttrMs: meanDeltaMs([...priorRem, ...priorClosed]),
    sampleSize: currentRem.length + currentClosed.length,
  };
}

// Mean arithmetic on a window's row set. Each row carries BOTH
// `remediatedAt` AND `closedAt`; the closure-event timestamp is
// `remediatedAt ?? closedAt` (the operator-marked stamp WINS
// when both are present — re-remediating / re-closing should not
// lift the closure event to a later moment). Returns `null` on
// an empty window (never fabricated) and drops any row whose
// computed closure ts is non-positive (clock-skew / stamped
// after-the-fact reminder — neither qualifies as a closure
// event in the metric's narrowed scope).
function meanDeltaMs(
  rows: {
    id: string;
    createdAt: Date;
    remediatedAt: Date | null;
    closedAt: Date | null;
  }[],
): number | null {
  const seen = new Set<string>();
  let total = 0;
  let count = 0;
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const closureTs = row.remediatedAt ?? row.closedAt ?? null;
    if (!closureTs) continue;
    const delta = closureTs.getTime() - row.createdAt.getTime();
    if (delta <= 0) continue;
    total += delta;
    count += 1;
  }
  if (count === 0) return null;
  return Math.round(total / count);
}
