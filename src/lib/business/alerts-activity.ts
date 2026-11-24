// @polsia:user-owned — Server-only helper that derives every alert's
// `lastActivityAt` stamp from a two-arm resolver. Picks the latest
// of:
//   1. MAX(AlertNote.createdAt) over the row's notes, OR
//   2. Alert.remediatedAt.
// When BOTH arms resolve to null (the row has no handoff notes AND
// has never been remediated), the helper returns `null` — the wire's
// explicit "no activity yet" rather than inventing a date from
// `Alert.createdAt`. The UI maps that to the em-dash placeholder so
// every column reads from the same input set: row-level `createdAt`
// is the column right next door; ranking `lastActivityAt` falls back
// to `createdAt` only in the in-app comparator
// (`@/lib/business/alerts-sort.ts`), NOT in this helper. Mirror of
// the detail-surface contract posture so the two surfaces stay
// lockstep.
//
// Powers:
//   - GET /api/alerts (list) — batched read across the page slice.
//   - GET /api/alerts/[id] (detail) — single-row read.
//   - GET /api/alerts/export.csv — per-batch read inside the cursor
//     loop; the projection already selects `createdAt` so the
//     per-batch derivation stays cheap on memory.
// All three stamp the value on the wire envelope so the table
// column, the mobile card pill, and the CSV row stay lockstep.
//
// Stamp shape: `Date | null` on the helper boundary; the list helper
// returns `Map<string, Date | null>` so a row with no notes AND no
// remediation stamp is OMITTED from the map and round-trips as null
// on the wire through the `lastActivityMap.get(id) ?? null` lookup
// at `/api/alerts/route.ts`. Callers map to a `string | null`
// ISO-8601 at the route level via `.toISOString()`. Keeps the wire
// posture identical to `remediatedAt: null` so the UI's em-dash
// placeholder branch stays uniform across the two columns.
//
// Derive-not-stored: no Alert.lastActivityAt column. Adding one
// would force a migration AND require every write path (remediate,
// note POST, Alert.create) to also touch the stamp — out of scope
// per the brief, and the read-path cost is one indexed peer-read
// against `alertId in: […]`.
//
// Team-scoping mirror: every peer-read carries the same
// `alert: { teamId }` join so a tampered URL that finds its way
// into a per-id read cannot surface cross-team note-maxes. Same
// posture the existing `commentGroups` peer-read in /api/alerts
// upholds.

import 'server-only';
import { prisma } from '@/lib/db';

// `createdAt` is accepted for back-compat with the route-level
// projection that already selects it. The helper ignores it now
// (the two-arm resolver returns null on neither-input-set rather
// than falling back to `createdAt`); kept in the input shape so the
// route's existing call site compiles untouched. The comparator
// (`@/lib/business/alerts-sort.ts`) and the table render read
// `createdAt` from the AlertItem directly.
interface ListRow {
  id: string;
  remediatedAt: Date | null;
  createdAt: Date;
}

export async function computeAlertLastActivityAtForList(
  rows: ListRow[],
  teamId: string,
): Promise<Map<string, Date | null>> {
  if (rows.length === 0) return new Map();
  const groups = await prisma.alertNote.groupBy({
    by: ['alertId'],
    where: {
      alertId: { in: rows.map((r) => r.id) },
      alert: { teamId },
    },
    _max: { createdAt: true },
  });
  const noteMaxByAlertId = new Map<string, Date>();
  for (const g of groups) {
    if (g._max.createdAt) noteMaxByAlertId.set(g.alertId, g._max.createdAt);
  }
  const out = new Map<string, Date | null>();
  for (const r of rows) {
    const noteMax = noteMaxByAlertId.get(r.id) ?? null;
    const resolved =
      noteMax && r.remediatedAt
        ? noteMax.getTime() > r.remediatedAt.getTime()
          ? noteMax
          : r.remediatedAt
        : (noteMax ?? r.remediatedAt ?? null);
    out.set(r.id, resolved);
  }
  return out;
}

export async function computeAlertLastActivityAtForOne(
  alertId: string,
  remediatedAt: Date | null,
  _createdAt: Date,
  teamId: string,
): Promise<Date | null> {
  const groups = await prisma.alertNote.groupBy({
    by: ['alertId'],
    where: {
      alertId,
      alert: { teamId },
    },
    _max: { createdAt: true },
  });
  const noteMax = groups[0]?._max.createdAt ?? null;
  if (noteMax && remediatedAt) {
    return noteMax.getTime() > remediatedAt.getTime() ? noteMax : remediatedAt;
  }
  return noteMax ?? remediatedAt ?? null;
}
