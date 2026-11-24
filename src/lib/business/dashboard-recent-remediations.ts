// @polsia:user-owned — `loadDashboardRecentRemediations(teamId, now)`
// for GET /api/dashboard/recent-remediations. Server-only: imports
// `server-only` + `prisma`. The route layer
// (src/app/api/dashboard/recent-remediations) is the ONLY caller;
// never called from a Server Component, page body, or layout
// (data-plane rule).
//
// Strategy: ONE `prisma.alert.findMany` over the team's alerts
// with a non-null `Alert.remediatedAt`, ordered by `remediatedAt
// desc`, `take 5`. Then ONE follow-up `prisma.workspaceMember.findMany`
// resolves the per-row owner email via a single batched id-`in`
// lookup so the render path never N+1's user records.
//
// Filter shape (mirror of /api/alerts's hide-snoozed default):
//   - `teamId`                        — server-seeded from
//                                       `workspaceContext.workspaceId` so
//                                       the tile is scoped to the
//                                       caller's team on every read.
//   - `remediatedAt: { not: null }`   — only resolved-then-remediated
//                                       rows count. A row that was
//                                       resolved but NEVER remediated
//                                       contributes nothing to the
//                                       "Recent remediation" feed —
//                                       the brief is about what the
//                                       team acted on, not what they
//                                       closed.
//   - `OR: [{ snoozedUntil: null },   — strips operator-silenced
//            { snoozedUntil:          rows. A future-snoozed row
//              { lte: now } }]`        (`snoozedUntil > now`) is
//                                       hidden everywhere on /alerts
//                                       so it doesn't surface here
//                                       either; an expired snooze
//                                       (`snoozedUntil <= now`) is no
//                                       longer silenced and re-enters
//                                       the feed. This OR-exclusion
//                                       matches the /api/alerts
//                                       hide-snoozed posture 1:1.
//
// Narrow select (`id`, `source`, `remediatedAt`, `ownerId`, and the
// joined `finding.cveId`) plus a bounded `take: 5` keeps the wire
// move cheap: the row's `cveId` is read off the related
// `VulnerabilityFinding` (not a column on `Alert` directly — see
// the prisma/schema/alerts.prisma header) so the join-breadth is
// `cveId` only, not the full finding row.
//
// Index footprint (per prisma/schema/alerts.prisma):
//   - `@@index([teamId, remediatedAt])` — pair with `teamId` seeds
//     the cheap index-only probe for the row scan.
//   - `@@index([teamId, snoozedUntil])` — pair with `teamId` keeps
//     the OR-exclusion branch off a heap scan once snoozes are
//     common.
//
// Soft-delete / active-only filter rationale: `Alert` does NOT have a
// `deletedAt` column today — rows survive forever once inserted.
// `WorkspaceMember.status: 'active'` is enforced on the email
// lookup so an invite-only or deleted member row does NOT resolve
// an email for an existing remediated alert (a stale assignee
// would otherwise leak a defunct inbox to the tile). Mirrors the
// posture at /api/alerts/[id]/owner which validates
// `workspaceId == teamId AND status='active'`.
import 'server-only';
import { prisma } from '@/lib/db';

const TOP_N = 5;

export interface DashboardRecentRemediationItem {
  id: string;
  title: string;
  ownerEmail: string | null;
  remediatedAt: string;
}

export async function loadDashboardRecentRemediations(
  teamId: string,
  now: Date = new Date(),
): Promise<{ items: DashboardRecentRemediationItem[] }> {
  const rows = await prisma.alert.findMany({
    where: {
      teamId,
      remediatedAt: { not: null },
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
    },
    select: {
      id: true,
      source: true,
      remediatedAt: true,
      ownerId: true,
      // `cveId` is on `VulnerabilityFinding`, NOT a column on
      // `Alert` directly. Selecting it through the relation keeps
      // the join-breadth down to a single string column.
      finding: { select: { cveId: true } },
    },
    orderBy: { remediatedAt: 'desc' },
    take: TOP_N,
  });

  // Follow-up email resolve via a single batched `id-`in`-lookup.
  // Mirror of the actor-resolution posture at
  // /api/alerts/[id]/activity:79 — distinct owner ids only, then
  // one WorkspaceMember read with `status: 'active'` so an invite-
  // only or stale row never resolves an email.
  const distinctOwnerIds = Array.from(
    new Set(
      rows
        .map((row) => row.ownerId)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    ),
  );

  const memberRows = distinctOwnerIds.length
    ? await prisma.workspaceMember.findMany({
        where: { id: { in: distinctOwnerIds }, status: 'active' },
        select: { id: true, email: true },
      })
    : [];

  const emailById = new Map<string, string>(
    memberRows.map((member) => [member.id, member.email] as const),
  );

  // Map rows → wire-shape item. Title is best-effort:
  //   - prefer the joined `finding.cveId` (a real `CVE-YYYY-NNNN`
  //     literal when it's present),
  //   - else fall back to the row's free-form `source` column, so a
  //     manual row whose finding hasn't rolled into the cve-feed
  //     still gets a label.
  // `remediatedAt` is emitted as an ISO string so the client's
  // `formatRelative` helper has the wall-clock anchor it expects.
  // `ownerEmail` stays `null` when no active WorkspaceMember row
  // resolves — the client renders the literal "Unassigned" in that
  // case.
  //
  // Prisma 6 does NOT narrow the result type when the WHERE clause
  // stamps `remediatedAt: { not: null }`, so the `remediatedAt`
  // column still arrives as `Date | null`. The runtime null-check
  // is the guarantee; we skip any defensive row so the cast to
  // `<DashboardRecentRemediationItem>` on `remediatedAt` stays
  // sound.
  const items: DashboardRecentRemediationItem[] = [];
  for (const row of rows) {
    if (!row.remediatedAt) continue;
    const title =
      row.finding?.cveId && row.finding.cveId.length > 0 ? row.finding.cveId : row.source;
    const ownerEmail = row.ownerId ? (emailById.get(row.ownerId) ?? null) : null;
    items.push({
      id: row.id,
      title,
      ownerEmail,
      remediatedAt: row.remediatedAt.toISOString(),
    });
  }

  return { items };
}
