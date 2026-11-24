// @polsia:user-owned — `loadDashboardScanCoverage(teamId)` for
// GET /api/dashboard/scan-coverage. Server-only: imports `server-only`
// + `prisma`. The route layer
// (src/app/api/dashboard/scan-coverage/route.ts) is the ONLY caller;
// never called from a Server Component, page body, or layout
// (data-plane rule).
//
// Strategy: ONE `prisma.alert.findMany` over the team's alerts with a
// joined `finding.asset.host`, then ONE follow-up
// `computeAlertLastActivityAtForList` peer-read for the
// `lastScanActivityAt` stamp. No `take` cap is needed here — this is a
// single team-wide scan-coverage rollup, not a paginated table; the
// `Alert` select is narrow (id, status, createdAt, remediatedAt +
// joined finding.asset.host) and rides existing
// `@@index([teamId, ...])` composites.
//
// Filter shape (mirror of /api/assets:108-114):
//   - `teamId`                   — server-seeded from
//                                  `workspaceContext.workspaceId` so the tile
//                                  is scoped to the caller's team on
//                                  every read.
//   - `findingId: { not: 'manual' }` — manual rows carry no
//                                  `finding.asset.host` and would
//                                  silently crash the host reduce.
//                                  Same posture as /api/assets /
//                                  /alerts.
//
// Reduce strategy (in app, by raw `Asset.host`):
//   - `totalHosts`            — distinct `Asset.host` count for the
//                               team. Set semantics: a host that
//                               covers two ports/protocols of the
//                               same hostname still counts as one.
//   - `hostsWithOpenAlerts`   — Sub-set: count of those hosts whose
//                               `status === 'open'` reducer saw at
//                               least one `open` contribution.
//                               Severity is intentionally NOT
//                               weighted; the brief specifies "hosts
//                               with at least one open alert", full
//                               stop. A single open-alert row at
//                               that host qualifies; we don't reuse
//                               the `dashboard-top-assets` score
//                               ladder.
//
// Activity stamp posture:
//   - We MAX `lastScanActivityAt` across EVERY contributing alert
//     for the union (not per host, per team) — the brief specifies
//     "the most recent alert timestamp", wired as a team MAX so the
//     tile shows the team's freshest scan stamp. Falls back to
//     `null` when no contributing alert produces a stamp (a team
//     with zero contributing alerts). Never falls back to
//     `Alert.createdAt` so the wire shape matches /api/assets's
//     `lastActivityAt: string | null` exactly.

import 'server-only';
import { computeAlertLastActivityAtForList } from '@/lib/business/alerts-activity';
import { prisma } from '@/lib/db';

export interface DashboardScanCoverage {
  totalHosts: number;
  hostsWithOpenAlerts: number;
  lastScanActivityAt: string | null;
}

export async function loadDashboardScanCoverage(teamId: string): Promise<DashboardScanCoverage> {
  const rows = await prisma.alert.findMany({
    where: {
      teamId,
      findingId: { not: 'manual' },
    },
    select: {
      id: true,
      status: true,
      createdAt: true,
      remediatedAt: true,
      finding: {
        select: {
          asset: { select: { host: true } },
        },
      },
    },
  });

  const hostsSeen = new Set<string>();
  const hostsWithOpen = new Set<string>();
  for (const row of rows) {
    const host = row.finding?.asset?.host;
    if (!host) continue;
    hostsSeen.add(host);
    if (row.status === 'open') hostsWithOpen.add(host);
  }

  // Peer-read the team-scoped note-max stamp for every contributing
  // alert, then take the team MAX. The helper returns `null` per
  // alert when no note and no `remediatedAt` produce a fresh stamp;
  // we skip nulls so a row that never had a note contributes nil
  // (its `createdAt` is intentionally NOT borrowed — matches the
  // /api/assets wire posture exactly).
  const activityMap = await computeAlertLastActivityAtForList(
    rows.map((r) => ({ id: r.id, remediatedAt: r.remediatedAt, createdAt: r.createdAt })),
    teamId,
  );

  let teamMax: Date | null = null;
  for (const stamp of activityMap.values()) {
    if (stamp == null) continue;
    if (teamMax == null || stamp.getTime() > teamMax.getTime()) {
      teamMax = stamp;
    }
  }

  return {
    totalHosts: hostsSeen.size,
    hostsWithOpenAlerts: hostsWithOpen.size,
    lastScanActivityAt: teamMax ? teamMax.toISOString() : null,
  };
}
