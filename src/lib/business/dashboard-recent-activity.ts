// @polsia:user-owned — `loadDashboardRecentActivity(teamId, now, take)`
// for GET /api/dashboard/recent-activity. Server-only: imports
// `server-only` + `prisma` + `sinceToBoundDate`. The route layer
// (src/app/api/dashboard/recent-activity) is the ONLY caller. Never
// called from a Server Component, page body, or layout (data-plane
// rule).
//
// Strategy: ONE broad `Alert.findMany` over the union of three
// lifecycle-event arms (`createdAt >= since`, `closedAt >= since`,
// `reopenedAt >= since`), narrowed to `take * 4` rows so a row-rich
// team never drifts into an unbounded heap scan. Each row can emit
// 1–3 events depending on which timestamps fall inside the window;
// the in-memory merge collapses the union into a single sorted
// timeline and slices the top `take`.
//
// Why a SINGLE broad findMany instead of three per-arm queries:
//   - Three separate finds would each need their own 7d bound and
//     their own peer-read for actor resolution. Combining into one
//     OR clause means ONE 7d bound, ONE row-set to post-process,
//     ONE batched `user.findMany` for actor names.
//   - The OR width is index-covered: each arm has its own
//     `@@index([teamId, <ts>])` so Postgres can pick the lowest-
//     cardinality arm and Bitmap-OR the rest.
//
// Lifecycle posture (per `alerts/[id]/activity/route.ts:21-22`):
// no separate `AlertActivity` table today — events are stamped
// directly off the trio of close/reopen/false-positive columns
// on the Alert row. A row that flips `resolved → open` inside
// the window emits TWO events (one `Resolved`, one `Reopened`).
// Both surface in the feed (additive only — single event header
// is a future expansion).
//
// `now` and `take` are injectable to keep the selector pure for
// tests.

import 'server-only';
import { sinceToBoundDate } from '@/lib/business/alerts-since';
import {
  DashboardActivityItem,
  type DashboardActivityItem as DashboardActivityItemType,
} from '@/lib/contracts/dashboard';
import { prisma } from '@/lib/db';

const DEFAULT_TAKE = 8;

export async function loadDashboardRecentActivity(
  teamId: string,
  now: Date = new Date(),
  take: number = DEFAULT_TAKE,
): Promise<{ items: DashboardActivityItemType[]; nextCursor: string | null }> {
  // Hard-cap server-side. The route never reads a `take` URL
  // parameter (this constant is the only knob) so a fresh brief
  // adding a `take=…` parameter surface can't drift past 8 events
  // per page.
  const cappedTake = Math.max(1, Math.min(8, Math.floor(take)));
  const sweepWindow = sinceToBoundDate('7d', now);
  // Pull four times the per-window cap so the in-memory merge
  // across three arms never drops events because one arm
  // saturated to the cap. Concrete: 8 × 4 = 32 rows max; bounded.
  const sweepTake = cappedTake * 4;

  // Single OR'd findMany. Each arm has its own composite index
  // on `(teamId, <ts>)` so Postgres plans via the lowest-cardinality
  // arm and Bitmap-ORs the rest. OrderBy is monotone on
  // `createdAt desc` as a pre-sort — the in-memory merge below
  // re-sorts by the effective event `at`, but the SQL ordering
  // keeps the wire stable when event timestamps tie.
  const rows = await prisma.alert.findMany({
    where: {
      teamId,
      OR: [
        { createdAt: { gte: sweepWindow } },
        { closedAt: { gte: sweepWindow } },
        { reopenedAt: { gte: sweepWindow } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: sweepTake,
    select: {
      id: true,
      severity: true,
      source: true,
      createdAt: true,
      closedAt: true,
      closedBy: true,
      closingNote: true,
      reopenedAt: true,
      reopenedBy: true,
      reopenReason: true,
      findingId: true,
      finding: { select: { cveId: true } },
    },
  });

  // Build the per-event list. A row can emit 1–3 events
  // depending on which timestamps fall inside the window.
  // `createdAt` is non-null on every row (Prisma default +
  // NOT NULL column), so it always emits a `created` event.
  // `closedAt` / `reopenedAt` are nullable, so each emits iff
  // non-null AND inside the window — matching the per-arm OR
  // semantics above.
  const events: Array<{
    kind: 'created' | 'resolved' | 'reopened';
    at: Date;
    actorId: string | null;
    reason: string | null;
    alertId: string;
    alertTitleSource: string;
    severity: string | null;
    cveId: string;
  }> = [];
  for (const r of rows) {
    events.push({
      kind: 'created',
      at: r.createdAt,
      actorId: null,
      reason: null,
      alertId: r.id,
      alertTitleSource: r.source,
      severity: r.severity,
      cveId: r.finding?.cveId ?? '',
    });
    if (r.closedAt && r.closedAt >= sweepWindow) {
      events.push({
        kind: 'resolved',
        at: r.closedAt,
        actorId: r.closedBy,
        reason: r.closingNote,
        alertId: r.id,
        alertTitleSource: r.source,
        severity: r.severity,
        cveId: r.finding?.cveId ?? '',
      });
    }
    if (r.reopenedAt && r.reopenedAt >= sweepWindow) {
      events.push({
        kind: 'reopened',
        at: r.reopenedAt,
        actorId: r.reopenedBy,
        reason: r.reopenReason,
        alertId: r.id,
        alertTitleSource: r.source,
        severity: r.severity,
        cveId: r.finding?.cveId ?? '',
      });
    }
  }

  // Sort by effective `at` desc, then by `alertId` for a stable
  // tiebreak so two events stamped the same millisecond pair with
  // a deterministic order across requests.
  events.sort((a, b) => {
    const t = b.at.getTime() - a.at.getTime();
    if (t !== 0) return t;
    return a.alertId < b.alertId ? -1 : a.alertId > b.alertId ? 1 : 0;
  });
  const sliced = events.slice(0, cappedTake);

  // Batch-resolve actor display names. Mirrors the peer-read
  // posture at /api/alerts/[id]/activity:79. Distinct actorIds
  // only — soft-fail on a stale User row by leaving the name
  // null.
  const actorIds = Array.from(
    new Set(
      sliced
        .map((e) => e.actorId)
        .filter((v): v is string => typeof v === 'string' && v.length > 0),
    ),
  );
  const userRows = actorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(userRows.map((u) => [u.id, u.name ?? null] as const));

  // Build the validated envelope. `created` events have no actor
  // (a row is born from an ingestion event, not a UI action), so
  // the actor fields stamp `null` on that branch regardless of the
  // row's later state. `alertTitle` falls back to `cveId` when
  // no richer title is available — the route stamps `source` as
  // the primary title source, but `source` is unreliable as a
  // user-facing title on manual rows. The cold-start branch (a
  // row whose `cveId` join is empty) gets an em-dash so the UI
  // can render an honest "—" rather than a stale literal.
  const items: DashboardActivityItemType[] = sliced.map((e) => {
    const base = {
      at: e.at.toISOString(),
      actorId: e.kind === 'created' ? null : e.actorId,
      actorName: e.kind === 'created' ? null : (nameById.get(e.actorId ?? '') ?? null),
      reason: e.reason,
      alertId: e.alertId,
      alertTitle: e.cveId && e.cveId.length > 0 ? e.cveId : e.alertTitleSource || '—',
      severity: e.severity,
      cveId: e.cveId,
    };
    return DashboardActivityItem.parse({ kind: e.kind, ...base });
  });

  return {
    items,
    // v1 cursor — always null. Reserved for a future expansion
    // to a real paginated timeline.
    nextCursor: null,
  };
}
