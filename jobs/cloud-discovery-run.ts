// @polsia:user-owned — cloud-discovery-run cron entry. Drains per-team
// CloudDiscoverySchedule rows whose `nextRunAt` has passed and dispatches
// each team connection through the same business lib the v1
// /api/v1/{aws,azure,gcp}/discover handlers funnel into.
//
// One-shot per minute (fires at the top of every cron tick). Soft-fail at
// every layer so a single misbehaving connection or row never blocks the
// drain:
//   - top-level `try/catch` swallows DB errors with a console breadcrumb
//   - per-schedule `try/catch` so a bad row does not abort the batch
//   - per-connection `try/catch` so one team's bad connection does not
//     prevent the next team from queuing its connection
//
// Idempotency / progress:
//   - The cron stamps `lastRunAt = now` AND `nextRunAt = now + cadence`
//     in the OUTER try, so even when an inner dispatch throws the schedule
//     still advances. It must NEVER re-fire the same row on a re-run of
//     the same minute.
//   - Selection is `nextRunAt <= now`, batched `take: 100` so even if we
//     backlog greatly the worst case stays bounded.
//
// Team → connections: connections live on the per-cloud models as
// `userId`-scoped rows (no teamId column on the connection tables).
// `Membership` is the join — list its rows for `schedule.teamId`,
// collect the userIds, then list connections for those userIds.
//
// NOTE: relative imports only — no `@/...` aliases. The cron command is a
// plain Node shell launched via `npx --yes tsx jobs/cloud-discovery-run.ts`.

import { dispatchDiscoveryRun } from '../src/lib/business/cloud/discovery-schedule';
import type { CloudDiscoveryProvider } from '../src/lib/contracts/cloud-discovery';
import { prisma } from '../src/lib/db';

const BATCH_SIZE = 100;
const MIN_CADENCE_MINUTES = 60;

interface DueSchedule {
  id: string;
  teamId: string;
  provider: string;
  cadenceMinutes: number;
}

// Selector helper exported for tests. The runtime itself uses the same
// `where: { nextRunAt: { lte: now } }` Prisma filter — the helper isolates
// the predicate so it can be unit-tested without a DB.
export function isScheduleDue(schedule: { nextRunAt: Date | null }, now: Date): boolean {
  if (!schedule.nextRunAt) return true;
  return schedule.nextRunAt.getTime() <= now.getTime();
}

function isValidProvider(p: string): p is CloudDiscoveryProvider {
  return p === 'aws' || p === 'azure' || p === 'gcp';
}

// Resolve every connection row owned by a member of `teamId` for a given
// connection provider. Returns empty (no throw) when the team has no
// members or no connections.
async function listConnectionsForTeam(
  teamId: string,
  provider: CloudDiscoveryProvider,
): Promise<Array<{ id: string; userId: string; regions: string[] }>> {
  const members = await prisma.membership.findMany({
    where: { teamId },
    select: { userId: true },
  });
  if (members.length === 0) return [];
  const userIds = Array.from(new Set(members.map((m) => m.userId)));

  if (provider === 'aws') {
    const rows = await prisma.awsConnection.findMany({
      where: { userId: { in: userIds } },
      select: { id: true, userId: true, regions: true },
    });
    return rows.map((r) => ({ id: r.id, userId: r.userId, regions: r.regions }));
  }
  if (provider === 'azure') {
    const rows = await prisma.azureConnection.findMany({
      where: { userId: { in: userIds } },
      select: { id: true, userId: true, locations: true },
    });
    return rows.map((r) => ({ id: r.id, userId: r.userId, regions: r.locations }));
  }
  const rows = await prisma.gcpConnection.findMany({
    where: { userId: { in: userIds } },
    select: { id: true, userId: true, zones: true },
  });
  return rows.map((r) => ({ id: r.id, userId: r.userId, regions: r.zones }));
}

async function processSchedule(schedule: DueSchedule, now: Date): Promise<void> {
  // Defensive: POST enforces cadence >= 60 so a zero/negative read should
  // never happen. If it does (manual DB tweak), bump forward and skip.
  if (schedule.cadenceMinutes < MIN_CADENCE_MINUTES) {
    await prisma.cloudDiscoverySchedule.update({
      where: { id: schedule.id },
      data: { lastRunAt: now, nextRunAt: addMinutes(now, MIN_CADENCE_MINUTES) },
    });
    return;
  }

  // Stamp first; even on inner failure the schedule advances so we don't
  // hot-loop the same row.
  await prisma.cloudDiscoverySchedule.update({
    where: { id: schedule.id },
    data: {
      lastRunAt: now,
      nextRunAt: addMinutes(now, schedule.cadenceMinutes),
    },
  });

  if (!isValidProvider(schedule.provider)) {
    // Defensive against a corrupted row; the schedule is already bumped.
    return;
  }
  const provider: CloudDiscoveryProvider = schedule.provider;

  let connections: Array<{ id: string; userId: string; regions: string[] }> = [];
  try {
    connections = await listConnectionsForTeam(schedule.teamId, provider);
  } catch (err) {
    // eslint-disable-next-line no-console -- intentionally a deploy-log breadcrumb
    console.error('[cloud-discovery-run] connection-lookup failed', {
      scheduleId: schedule.id,
      provider,
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  for (const conn of connections) {
    try {
      await dispatchDiscoveryRun({
        provider,
        connectionId: conn.id,
        userId: conn.userId,
        regions: conn.regions,
      });
    } catch (err) {
      // eslint-disable-next-line no-console -- intentionally a deploy-log breadcrumb
      console.error('[cloud-discovery-run] dispatch failed', {
        scheduleId: schedule.id,
        provider,
        connectionId: conn.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

export async function main(nowArg?: Date): Promise<void> {
  const now = nowArg ?? new Date();
  try {
    const due = await prisma.cloudDiscoverySchedule.findMany({
      where: { nextRunAt: { lte: now } },
      orderBy: { nextRunAt: 'asc' },
      take: BATCH_SIZE,
    });
    if (due.length === 0) return;

    for (const schedule of due) {
      try {
        await processSchedule(
          {
            id: schedule.id,
            teamId: schedule.teamId,
            provider: schedule.provider,
            cadenceMinutes: schedule.cadenceMinutes,
          },
          now,
        );
      } catch (err) {
        // eslint-disable-next-line no-console -- intentionally a deploy-log breadcrumb
        console.error('[cloud-discovery-run] schedule failed', {
          scheduleId: schedule.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console -- intentionally a deploy-log breadcrumb
    console.error('[cloud-discovery-run]', err);
  }
}

// Auto-invoke is suppressed under vitest so the test harness can drive
// `main()` directly. Production cron runs never set VITEST/NODE_ENV=test.
if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
  main()
    .catch((err: unknown) => {
      console.error('[cloud-discovery-run] uncaught', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await prisma.$disconnect();
      } catch (err) {
        console.error('[cloud-discovery-run] prisma disconnect failed', err);
        process.exitCode = 1;
      }
    });
}
