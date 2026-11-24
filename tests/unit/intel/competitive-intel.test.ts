// @vitest-environment node
// Unit tests for jobs/competitive-intel-run.ts + the /api/intel/runs
// family. Mirrors the structure of tests/unit/api/alerts-route.test.ts:
// module-level `vi.mock('server-only'/'@/lib/db'/'@/lib/team-auth')`,
// one swappable mock per Prisma dependency. Cases:
//   1. One row per team per UTC day
//   2. Idempotent re-run within the same UTC day
//   3. AI failure isolation per team
//   4. Cross-team rejection on detail API (404)
//   5. List ordering and team-scoping on /api/intel/runs

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const teamFindMany = vi.fn();
const competitiveIntelRunFindUnique = vi.fn();
const competitiveIntelRunCreate = vi.fn();
const competitiveIntelRunFindMany = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    team: { findMany: teamFindMany },
    competitiveIntelRun: {
      findUnique: competitiveIntelRunFindUnique,
      create: competitiveIntelRunCreate,
      findMany: competitiveIntelRunFindMany,
    },
  },
}));

const generateObjectMock = vi.fn();

vi.mock('@/lib/ai/client', () => ({
  generateObject: generateObjectMock,
}));

// Swappable mock for requireTeamRead.
const requireTeamReadMock = vi.fn();
requireTeamReadMock.mockResolvedValue({
  user: {
    id: 'user-1',
    email: 'a@example.com',
    name: 'A',
    emailVerified: true,
    role: 'member',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  membership: { id: 'mem-1', userId: 'user-1', teamId: 'team-A', role: 'member' },
  team: { id: 'team-A', name: 'Team A' },
});

vi.mock('@/lib/team-auth', () => ({
  requireTeamRead: requireTeamReadMock,
}));

// Force the cron's vitest guard against the auto-invoke so we can drive
// `main()` directly with an injected clock.
process.env.NODE_ENV = 'test';

beforeEach(() => {
  vi.resetModules();
  teamFindMany.mockReset();
  competitiveIntelRunFindUnique.mockReset();
  competitiveIntelRunCreate.mockReset();
  competitiveIntelRunFindMany.mockReset();
  generateObjectMock.mockReset();
  requireTeamReadMock.mockReset();
  requireTeamReadMock.mockResolvedValue({
    user: {
      id: 'user-1',
      email: 'a@example.com',
      name: 'A',
      emailVerified: true,
      role: 'member',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    membership: { id: 'mem-1', userId: 'user-1', teamId: 'team-A', role: 'member' },
    team: { id: 'team-A', name: 'Team A' },
  });
});

afterEach(() => {
  delete process.env.NODE_ENV;
});

describe('competitive-intel-run cron', () => {
  it('inserts one row per team per UTC day', async () => {
    const frozen = new Date('2026-07-24T02:00:00Z');
    const expectedRanAt = new Date('2026-07-24T00:00:00.000Z');

    teamFindMany.mockResolvedValueOnce([{ id: 'team-A' }, { id: 'team-B' }]);
    competitiveIntelRunFindUnique.mockResolvedValue(null);
    generateObjectMock.mockResolvedValue({
      headline: 'Stable read: no market-moving competitor moves in the last 24h.',
      body: 'Body goes here.',
    });

    const { main } = await import('../../../jobs/competitive-intel-run');
    await main(frozen);

    expect(competitiveIntelRunCreate).toHaveBeenCalledTimes(2);
    const callA = competitiveIntelRunCreate.mock.calls[0]?.[0] as {
      data: { teamId: string; ranAt: Date };
    };
    const callB = competitiveIntelRunCreate.mock.calls[1]?.[0] as {
      data: { teamId: string; ranAt: Date };
    };
    expect(callA.data.teamId).toBe('team-A');
    expect(callA.data.ranAt.getTime()).toBe(expectedRanAt.getTime());
    expect(callB.data.teamId).toBe('team-B');
    expect(callB.data.ranAt.getTime()).toBe(expectedRanAt.getTime());
  });

  it('is idempotent across re-fires within the same UTC day', async () => {
    const frozen = new Date('2026-07-24T02:00:00Z');

    teamFindMany.mockResolvedValueOnce([{ id: 'team-A' }, { id: 'team-B' }]);
    competitiveIntelRunFindUnique.mockImplementation(async (args: { where: unknown }) => {
      const where = args.where as { teamId_ranAt?: { teamId: string } };
      if (where.teamId_ranAt?.teamId === 'team-A') {
        return { id: 'pre-existing-A' };
      }
      return null;
    });
    generateObjectMock.mockResolvedValue({
      headline: 'fresh read',
      body: 'fresh body',
    });

    const { main } = await import('../../../jobs/competitive-intel-run');
    await main(frozen);

    // Only team-B was inserted; team-A was skipped because the unique
    // (teamId, ranAt) row pre-existed.
    expect(competitiveIntelRunCreate).toHaveBeenCalledTimes(1);
    const call = competitiveIntelRunCreate.mock.calls[0]?.[0] as {
      data: { teamId: string };
    };
    expect(call.data.teamId).toBe('team-B');
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
  });

  it('isolates AI failures per team', async () => {
    const frozen = new Date('2026-07-24T02:00:00Z');

    teamFindMany.mockResolvedValueOnce([{ id: 'team-A' }, { id: 'team-B' }]);
    competitiveIntelRunFindUnique.mockResolvedValue(null);
    // team-A's LLM call throws; team-B succeeds.
    generateObjectMock.mockImplementationOnce(async () => {
      throw new Error('Polsia AI proxy unavailable');
    });
    generateObjectMock.mockResolvedValueOnce({
      headline: 'team-B read',
      body: 'team-B body',
    });

    const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { main } = await import('../../../jobs/competitive-intel-run');
    await main(frozen);

    // Only team-B's row hit the DB; team-A's was skipped-and-logged.
    expect(competitiveIntelRunCreate).toHaveBeenCalledTimes(1);
    const call = competitiveIntelRunCreate.mock.calls[0]?.[0] as {
      data: { teamId: string };
    };
    expect(call.data.teamId).toBe('team-B');
    expect(stderrWriteSpy).toHaveBeenCalled();
    stderrWriteSpy.mockRestore();
  });

  it('bounds a stalled AI request and skips without inserting a placeholder', async () => {
    const frozen = new Date('2026-07-24T02:00:00Z');

    teamFindMany.mockResolvedValueOnce([{ id: 'team-A' }]);
    competitiveIntelRunFindUnique.mockResolvedValue(null);
    generateObjectMock.mockImplementationOnce(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('request aborted')), {
            once: true,
          });
        }),
    );

    const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();

    try {
      const { main } = await import('../../../jobs/competitive-intel-run');
      const run = main(frozen);
      await vi.advanceTimersByTimeAsync(30_000);
      await run;

      expect(competitiveIntelRunCreate).not.toHaveBeenCalled();
      expect(stderrWriteSpy).toHaveBeenCalledWith(
        '[competitive-intel] team=team-A skipped reason=ai_timeout\n',
      );
    } finally {
      vi.useRealTimers();
      stderrWriteSpy.mockRestore();
    }
  });
});

describe('/api/intel/runs/[id] access control', () => {
  // Cross-team rejection: a session whose membership points at team A
  // requesting a CompetitiveIntelRun owned by team B must receive a 404
  // (same opaque answer as a missing row — no existence-as-leak vector).

  it('returns 404 when caller from team A requests a row owned by team B', async () => {
    competitiveIntelRunFindUnique.mockResolvedValueOnce({
      id: 'row-B',
      teamId: 'team-B',
      ranAt: new Date('2026-07-24T00:00:00.000Z'),
      headline: 'Team B read',
      body: 'Team B body',
    });

    const { GET } = await import('../../../src/app/api/intel/runs/[id]/route');
    const res = await GET(new Request('http://test/'), {
      params: Promise.resolve({ id: 'row-B' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 200 with full body when the row belongs to caller team', async () => {
    competitiveIntelRunFindUnique.mockResolvedValueOnce({
      id: 'row-A',
      teamId: 'team-A',
      ranAt: new Date('2026-07-24T00:00:00.000Z'),
      headline: 'Team A read',
      body: 'Team A body',
    });

    const { GET } = await import('../../../src/app/api/intel/runs/[id]/route');
    const res = await GET(new Request('http://test/'), {
      params: Promise.resolve({ id: 'row-A' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; body: string; headline: string };
    expect(body.id).toBe('row-A');
    expect(body.headline).toBe('Team A read');
    expect(body.body).toBe('Team A body');
  });
});

describe('/api/intel/runs list', () => {
  it('returns rows newest-first by ranAt, scoped to caller team', async () => {
    competitiveIntelRunFindMany.mockResolvedValueOnce([
      {
        id: 'row-2026-07-24',
        ranAt: new Date('2026-07-24T00:00:00.000Z'),
        headline: 'Newest read',
      },
      {
        id: 'row-2026-07-23',
        ranAt: new Date('2026-07-23T00:00:00.000Z'),
        headline: 'Yesterday read',
      },
    ]);

    const { GET } = await import('../../../src/app/api/intel/runs/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items[0]?.id).toBe('row-2026-07-24');
    expect(body.items[1]?.id).toBe('row-2026-07-23');
    const args = competitiveIntelRunFindMany.mock.calls[0]?.[0] as {
      where: { teamId: string };
      orderBy: { ranAt: string };
      take: number;
    };
    expect(args.where.teamId).toBe('team-A');
    expect(args.orderBy.ranAt).toBe('desc');
    expect(args.take).toBe(50);
  });

  it('returns empty list envelope when no rows exist', async () => {
    competitiveIntelRunFindMany.mockResolvedValueOnce([]);

    const { GET } = await import('../../../src/app/api/intel/runs/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });
});
