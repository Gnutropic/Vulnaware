// @vitest-environment node
// Unit tests for jobs/cloud-discovery-run.ts. Two due schedules:
//   - A lookup for one of them throws — outer try must still advance its
//     stamp so it does not re-fire the same minute
//   - The other one succeeds — verify dispatchDiscoveryRun is called and
//     its lastRunAt/nextRunAt stamps forward
//
// Plus a zero-due-schedule control: when nothing is due, no dispatching.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock BEFORE importing the cron (vitest hoists vi.mock per file).
// Use the path ALIASES (resolved via vitest.config.ts's alias map) so the
// cron's relative-import path `'../src/lib/db'` (which evaluates to the
// same absolute file) matches the mock here. Path-as-written matching
// means the alias form is the only one that intercepts both styles.
const scheduleFindMany = vi.fn();
const scheduleUpdate = vi.fn();
const membershipFindMany = vi.fn();
const awsConnectionFindMany = vi.fn();
const awsDiscoveryRunCreate = vi.fn();
const dispatchDiscoveryRun = vi.fn();

vi.mock('server-only', () => ({}));

vi.mock('@/lib/db', () => ({
  prisma: {
    cloudDiscoverySchedule: {
      findMany: scheduleFindMany,
      update: scheduleUpdate,
    },
    membership: { findMany: membershipFindMany },
    awsConnection: { findMany: awsConnectionFindMany },
    awsDiscoveryRun: { create: awsDiscoveryRunCreate },
  },
}));

vi.mock('@/lib/business/cloud/discovery-schedule', () => ({
  dispatchDiscoveryRun,
}));

// The cron uses NODE_ENV='test' as the auto-run guard; production cron
// runs always have NODE_ENV unset.
process.env.NODE_ENV = 'test';

beforeEach(() => {
  vi.resetModules();
  scheduleFindMany.mockReset();
  scheduleUpdate.mockReset();
  membershipFindMany.mockReset();
  awsConnectionFindMany.mockReset();
  awsDiscoveryRunCreate.mockReset();
  dispatchDiscoveryRun.mockReset();
});

afterEach(() => {
  // Restore so other test files do not see NODE_ENV='test'.
  delete process.env.NODE_ENV;
});

describe('cloud-discovery-run cron', () => {
  it('stamps both schedules forward when one connection-lookup throws', async () => {
    const now = new Date('2026-07-22T12:00:00Z');
    const scheduleA = {
      id: 'sched-A',
      teamId: 'team-A',
      provider: 'aws',
      cadenceMinutes: 120,
    };
    const scheduleB = {
      id: 'sched-B',
      teamId: 'team-B',
      provider: 'aws',
      cadenceMinutes: 60,
    };

    scheduleFindMany.mockResolvedValueOnce([scheduleA, scheduleB]);
    // Lookups fire in declaration order: scheduleA first (throws), then B.
    membershipFindMany.mockRejectedValueOnce(new Error('DB down for team A'));
    membershipFindMany.mockResolvedValueOnce([{ userId: 'u-B' }]);
    awsConnectionFindMany.mockResolvedValueOnce([
      { id: 'conn-B', userId: 'u-B', regions: ['us-east-1'] },
    ]);
    scheduleUpdate.mockResolvedValue({});

    dispatchDiscoveryRun.mockResolvedValueOnce({
      runId: 'run-B',
      pollUrl: '/api/v1/aws/discover/run-B',
    });

    const { main } = await import('../../../jobs/cloud-discovery-run');

    await main(now);

    // Both schedules were stamped forward. The order is A (thrown) then B.
    expect(scheduleUpdate).toHaveBeenCalledTimes(2);
    const stampA = scheduleUpdate.mock.calls[0]?.[0] as {
      where: { id: string };
      data: { lastRunAt: Date; nextRunAt: Date };
    };
    const stampB = scheduleUpdate.mock.calls[1]?.[0] as {
      where: { id: string };
      data: { lastRunAt: Date; nextRunAt: Date };
    };
    expect(stampA.where.id).toBe('sched-A');
    expect(stampA.data.lastRunAt.getTime()).toBe(now.getTime());
    expect(stampA.data.nextRunAt.getTime()).toBe(now.getTime() + 120 * 60_000);
    expect(stampB.where.id).toBe('sched-B');
    expect(stampB.data.lastRunAt.getTime()).toBe(now.getTime());
    expect(stampB.data.nextRunAt.getTime()).toBe(now.getTime() + 60 * 60_000);

    // Only B's connection ever produced a dispatch.
    expect(dispatchDiscoveryRun).toHaveBeenCalledTimes(1);
    expect(dispatchDiscoveryRun).toHaveBeenCalledWith({
      provider: 'aws',
      connectionId: 'conn-B',
      userId: 'u-B',
      regions: ['us-east-1'],
    });
  });

  it('does not call dispatchDiscoveryRun when no schedule is due', async () => {
    scheduleFindMany.mockResolvedValueOnce([]);
    const { main } = await import('../../../jobs/cloud-discovery-run');
    await main(new Date('2026-07-22T12:00:00Z'));
    expect(scheduleUpdate).not.toHaveBeenCalled();
    expect(dispatchDiscoveryRun).not.toHaveBeenCalled();
  });

  it('falls back to a safe cadence when a bad row sneaks through', async () => {
    const now = new Date('2026-07-22T12:00:00Z');
    scheduleFindMany.mockResolvedValueOnce([
      {
        id: 'sched-bad',
        teamId: 'team-bad',
        provider: 'aws',
        cadenceMinutes: 0, // never allowed at the POST contract, defensive only
      },
    ]);
    scheduleUpdate.mockResolvedValueOnce({});

    const { main } = await import('../../../jobs/cloud-discovery-run');
    await main(now);

    // Cadence was clamped to MIN_CADENCE_MINUTES (60) — no dispatch attempted.
    const stamp = scheduleUpdate.mock.calls[0]?.[0] as {
      data: { lastRunAt: Date; nextRunAt: Date };
    };
    expect(stamp.data.nextRunAt.getTime()).toBe(now.getTime() + 60 * 60_000);
    expect(dispatchDiscoveryRun).not.toHaveBeenCalled();
    expect(membershipFindMany).not.toHaveBeenCalled();
  });
});
