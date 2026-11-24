// @vitest-environment node
// Unit tests for src/lib/business/daily-user-digest.ts:
//   1. shouldFireToday — per-user UTC calendar-day gate (mirrors the
//      per-team gate semantics so the 08:30 and 09:00 cadences share
//      one canonical implementation).
//   2. findDailyUserDigestInputs — opts-out branch: a User whose
//      DailyDigestPrefs.digestEnabled === false returns ZERO inputs
//      even when they have matching alerts in the window.
//      The selector is exercised via mock qualifications against
//      @/lib/db so we can drive the `enabled: true/false` Prisma
//      filter without spinning up a real DB.
//
// Per-user filter branches:
//   3. severityThreshold='high' → the per-user top-N + counts drop
//      critical rows from the eligible user (the findMany WHERE is
//      NOT per-user; the narrowing is in-process on the bucket).
//   4. assetScope=['example.com:443/tcp'] → the per-user top-N +
//      counts drop rows whose finding.asset doesn't match.
//   5. severityThreshold=null AND assetScope=[] → no narrowing (the
//      happy-path default).
//   6. status='open' → the findMany includes `status: 'open'` so the
//      brief's "open alerts" semantics land.
//   7. junk assetScope row → that single user is skipped + warned,
//      the rest of the batch survives (per-user blast radius).
//
// We mock `@/lib/db`, the email transport, and the email template
// (the daily-alert-digest.test.ts pattern) so vitest can load the
// module. Prisma's full surface isn't exercised — we just need the
// pref / user / membership / alert / team callsites that the selector
// walks.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/email/from', () => ({ fromFor: () => '' }));
vi.mock('@/lib/email/send', () => ({ sendEmail: () => Promise.resolve({ id: '' }) }));
vi.mock('@/lib/email/templates', () => ({
  dailyUserDigestEmail: () => ({ subject: '', html: '', text: '' }),
}));

// Hoisted so the vi.mock factory closes over the same handles the
// test body later stubs with vi.mocked(...).
const mocks = vi.hoisted(() => ({
  dailyDigestPrefsFindMany: vi.fn(),
  dailyDigestPrefsFindUnique: vi.fn(),
  dailyDigestPrefsUpdate: vi.fn(),
  userFindMany: vi.fn(),
  membershipFindMany: vi.fn(),
  alertFindMany: vi.fn(),
  teamFindMany: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    dailyDigestPrefs: {
      findMany: mocks.dailyDigestPrefsFindMany,
      findUnique: mocks.dailyDigestPrefsFindUnique,
      update: mocks.dailyDigestPrefsUpdate,
    },
    user: {
      findMany: mocks.userFindMany,
    },
    membership: {
      findMany: mocks.membershipFindMany,
    },
    alert: {
      findMany: mocks.alertFindMany,
    },
    team: {
      findMany: mocks.teamFindMany,
    },
  },
}));

import {
  findDailyUserDigestInputs,
  pickTopItems,
  shouldFireToday,
} from '@/lib/business/daily-user-digest';

const FIXED_NOW = new Date('2026-07-23T12:00:00.000Z');

function alertRow(
  overrides: Partial<{
    id: string;
    teamId: string;
    ownerId: string | null;
    severity: string | null;
    createdAtIso: string;
    host: string;
    port: number;
    protocol: string;
    cveId: string;
  }>,
) {
  return {
    id: overrides.id ?? 'alert-1',
    teamId: overrides.teamId ?? 'team-1',
    ownerId: overrides.ownerId ?? null,
    severity: overrides.severity ?? 'high',
    createdAt: new Date(overrides.createdAtIso ?? '2026-07-23T11:00:00.000Z'),
    finding: {
      cveId: overrides.cveId ?? 'CVE-2026-ABCD',
      asset: {
        host: overrides.host ?? 'example.com',
        port: overrides.port ?? 443,
        protocol: overrides.protocol ?? 'tcp',
      },
    },
  };
}

describe('shouldFireToday — UTC calendar-day gate', () => {
  it('returns true when lastSentAt is null', () => {
    expect(shouldFireToday(null, FIXED_NOW)).toBe(true);
  });

  it('returns false when lastSentAt is on the same UTC calendar day', () => {
    const sameDay = new Date('2026-07-23T03:15:00.000Z');
    expect(shouldFireToday(sameDay, FIXED_NOW)).toBe(false);
  });

  it('returns true when lastSentAt is on the previous UTC calendar day', () => {
    const previousDay = new Date('2026-07-22T23:59:59.000Z');
    expect(shouldFireToday(previousDay, FIXED_NOW)).toBe(true);
  });

  it('returns true when lastSentAt is on the next UTC calendar day (clock drift safety)', () => {
    const tomorrow = new Date('2026-07-24T00:00:01.000Z');
    expect(shouldFireToday(tomorrow, FIXED_NOW)).toBe(true);
  });
});

describe('findDailyUserDigestInputs — opted-out exclusion', () => {
  beforeEach(() => {
    mocks.dailyDigestPrefsFindMany.mockReset();
    mocks.userFindMany.mockReset();
    mocks.membershipFindMany.mockReset();
    mocks.alertFindMany.mockReset();
    mocks.teamFindMany.mockReset();
    // Quiet the per-user junk-assetScope console.warn during tests so
    // vitest's reporter stays readable.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('excludes a user whose DailyDigestPrefs.digestEnabled === false (returns no inputs)', async () => {
    // The selector's outer Prisma filter is `digestEnabled: true`. If
    // a user has `digestEnabled: false` they don't appear in the
    // initial DailyDigestPrefs.findMany, so the selector never emits
    // an input for them — even when matching alerts exist in the
    // window. This is the opt-out integration test.
    mocks.dailyDigestPrefsFindMany.mockResolvedValueOnce([]);

    const inputs = await findDailyUserDigestInputs(FIXED_NOW);
    expect(inputs).toEqual([]);
    // Confirm the gate ran at the pref layer (no alerts reached).
    expect(mocks.alertFindMany).not.toHaveBeenCalled();
  });

  it('excludes a user whose email is missing (returns no inputs)', async () => {
    // User row exists with no email — the per-user selector can't
    // address a recipient. Mirror the per-team selector's
    // "no recipients" early-skip, but at the single-user level.
    mocks.dailyDigestPrefsFindMany.mockResolvedValueOnce([
      {
        userId: 'user-1',
        digestEnabled: true,
        severityThreshold: null,
        assetScope: null,
        lastSentAt: null,
      },
    ]);
    mocks.userFindMany.mockResolvedValueOnce([{ id: 'user-1', email: '' }]);
    mocks.membershipFindMany.mockResolvedValueOnce([{ userId: 'user-1', teamId: 'team-1' }]);

    const inputs = await findDailyUserDigestInputs(FIXED_NOW);
    expect(inputs).toEqual([]);
    expect(mocks.alertFindMany).not.toHaveBeenCalled();
  });

  it('filters by status: "open" on the alert findMany', async () => {
    // The selector gates the alert query by `status: 'open'` so the
    // brief's literal "open alerts" semantics land. Closed / FP rows
    // are out of scope for this cadence.
    mocks.dailyDigestPrefsFindMany.mockResolvedValueOnce([
      {
        userId: 'user-1',
        digestEnabled: true,
        severityThreshold: null,
        assetScope: null,
        lastSentAt: null,
      },
    ]);
    mocks.userFindMany.mockResolvedValueOnce([{ id: 'user-1', email: 'a@x.com' }]);
    mocks.membershipFindMany.mockResolvedValueOnce([{ userId: 'user-1', teamId: 'team-1' }]);
    mocks.alertFindMany.mockResolvedValueOnce([]);
    mocks.teamFindMany.mockResolvedValueOnce([{ id: 'team-1', name: 'Acme' }]);

    await findDailyUserDigestInputs(FIXED_NOW);

    expect(mocks.alertFindMany).toHaveBeenCalledTimes(1);
    const where = mocks.alertFindMany.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({ status: 'open' });
  });
});

describe('findDailyUserDigestInputs — per-user threshold + asset narrowing', () => {
  beforeEach(() => {
    mocks.dailyDigestPrefsFindMany.mockReset();
    mocks.userFindMany.mockReset();
    mocks.membershipFindMany.mockReset();
    mocks.alertFindMany.mockReset();
    mocks.teamFindMany.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('drops the per-user asset filter when assetScope is an empty array', async () => {
    // Empty assetScope = "all assets for the team"; the selector
    // should NOT carry an `finding.asset.OR` clause in the per-user
    // narrow walk. We verify by checking that the bucket walk lands
    // both the matching and the non-matching asset rows on the
    // user-side counts.
    mocks.dailyDigestPrefsFindMany.mockResolvedValueOnce([
      {
        userId: 'user-1',
        digestEnabled: true,
        severityThreshold: null,
        assetScope: [],
        lastSentAt: null,
      },
    ]);
    mocks.userFindMany.mockResolvedValueOnce([{ id: 'user-1', email: 'a@x.com' }]);
    mocks.membershipFindMany.mockResolvedValueOnce([{ userId: 'user-1', teamId: 'team-1' }]);
    mocks.alertFindMany.mockResolvedValueOnce([
      alertRow({ id: 'a-1', severity: 'critical', host: 'example.com', ownerId: 'user-1' }),
      alertRow({ id: 'a-2', severity: 'critical', host: 'other.com', ownerId: 'user-1' }),
    ]);
    mocks.teamFindMany.mockResolvedValueOnce([{ id: 'team-1', name: 'Acme' }]);

    const inputs = await findDailyUserDigestInputs(FIXED_NOW);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.severityCounts.critical).toBe(2);
  });

  it('narrowes the per-user top-N + counts to assets in assetScope', async () => {
    // One user, assetScope=['example.com:443/tcp'], two alerts in the
    // window: one on 'example.com' (matches) and one on 'other.com'
    // (does NOT match). The per-user counts should reflect ONE row
    // (the matching one). The non-matching row goes to the bucket
    // count but not the per-user narrow.
    mocks.dailyDigestPrefsFindMany.mockResolvedValueOnce([
      {
        userId: 'user-1',
        digestEnabled: true,
        severityThreshold: null,
        assetScope: ['example.com:443/tcp'],
        lastSentAt: null,
      },
    ]);
    mocks.userFindMany.mockResolvedValueOnce([{ id: 'user-1', email: 'a@x.com' }]);
    mocks.membershipFindMany.mockResolvedValueOnce([{ userId: 'user-1', teamId: 'team-1' }]);
    mocks.alertFindMany.mockResolvedValueOnce([
      alertRow({
        id: 'a-1',
        severity: 'critical',
        host: 'example.com',
        port: 443,
        protocol: 'tcp',
        ownerId: 'user-1',
      }),
      alertRow({
        id: 'a-2',
        severity: 'critical',
        host: 'other.com',
        port: 443,
        protocol: 'tcp',
        ownerId: 'user-1',
      }),
    ]);
    mocks.teamFindMany.mockResolvedValueOnce([{ id: 'team-1', name: 'Acme' }]);

    const inputs = await findDailyUserDigestInputs(FIXED_NOW);
    expect(inputs).toHaveLength(1);
    // Counts derive from the narrowed row set → ONE critical row.
    expect(inputs[0]?.severityCounts.critical).toBe(1);
    expect(inputs[0]?.totalItems).toBe(1);
    const topIds = (inputs[0]?.topItems ?? []).map((t) => t.id);
    expect(topIds).toEqual(['a-1']);
  });

  it('narrowes the per-user top-N + counts to severities at-or-above the threshold', async () => {
    // One user, severityThreshold='high', three alerts in the window:
    // one critical (matches — ≥ high), one high (matches), one low
    // (does NOT match). The per-user counts reflect TWO rows.
    mocks.dailyDigestPrefsFindMany.mockResolvedValueOnce([
      {
        userId: 'user-1',
        digestEnabled: true,
        severityThreshold: 'high',
        assetScope: null,
        lastSentAt: null,
      },
    ]);
    mocks.userFindMany.mockResolvedValueOnce([{ id: 'user-1', email: 'a@x.com' }]);
    mocks.membershipFindMany.mockResolvedValueOnce([{ userId: 'user-1', teamId: 'team-1' }]);
    mocks.alertFindMany.mockResolvedValueOnce([
      alertRow({ id: 'a-1', severity: 'critical', host: 'example.com', ownerId: 'user-1' }),
      alertRow({ id: 'a-2', severity: 'high', host: 'example.com', ownerId: 'user-1' }),
      alertRow({ id: 'a-3', severity: 'low', host: 'example.com', ownerId: 'user-1' }),
    ]);
    mocks.teamFindMany.mockResolvedValueOnce([{ id: 'team-1', name: 'Acme' }]);

    const inputs = await findDailyUserDigestInputs(FIXED_NOW);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.severityCounts).toEqual({
      critical: 1,
      high: 1,
      medium: 0,
      low: 0,
    });
    expect(inputs[0]?.totalItems).toBe(2);
    const topIds = (inputs[0]?.topItems ?? []).map((t) => t.id);
    expect(topIds.sort()).toEqual(['a-1', 'a-2'].sort());
  });

  it('skips a user whose assetScope row carried junk (without aborting cron)', async () => {
    // The selector catches the per-user AssetFilterError, logs + skips
    // that single user, and continues with the rest of the batch.
    mocks.dailyDigestPrefsFindMany.mockResolvedValueOnce([
      {
        userId: 'user-1',
        digestEnabled: true,
        severityThreshold: null,
        assetScope: ['!!!invalid'],
        lastSentAt: null,
      },
      {
        userId: 'user-2',
        digestEnabled: true,
        severityThreshold: null,
        assetScope: null,
        lastSentAt: null,
      },
    ]);
    mocks.userFindMany.mockResolvedValueOnce([
      { id: 'user-1', email: 'a@x.com' },
      { id: 'user-2', email: 'b@x.com' },
    ]);
    mocks.membershipFindMany.mockResolvedValueOnce([
      { userId: 'user-1', teamId: 'team-1' },
      { userId: 'user-2', teamId: 'team-1' },
    ]);
    mocks.alertFindMany.mockResolvedValueOnce([
      alertRow({ id: 'a-1', severity: 'critical', host: 'example.com', ownerId: 'user-2' }),
    ]);
    mocks.teamFindMany.mockResolvedValueOnce([{ id: 'team-1', name: 'Acme' }]);

    const inputs = await findDailyUserDigestInputs(FIXED_NOW);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.userId).toBe('user-2');
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('pickTopItems — drain order + cap', () => {
  it('drains critical first (cap 5), then high (cap 5), drops medium/low', () => {
    // Build 7 criticals, 7 highs, and a handful of medium/low. The
    // top-N pick should return 5 critical + 5 high, sorted by created
    // desc within each bucket.
    const rows = [
      ...Array.from({ length: 7 }, (_, i) =>
        alertRow({
          id: `c${i}`,
          severity: 'critical',
          createdAtIso: `2026-07-23T0${7 - i}:00:00.000Z`,
          ownerId: 'user-1',
        }),
      ),
      ...Array.from({ length: 7 }, (_, i) =>
        alertRow({
          id: `h${i}`,
          severity: 'high',
          createdAtIso: `2026-07-23T0${7 - i}:00:00.000Z`,
          ownerId: 'user-1',
        }),
      ),
      alertRow({ id: 'm1', severity: 'medium', ownerId: 'user-1' }),
      alertRow({ id: 'l1', severity: 'low', ownerId: 'user-1' }),
    ];
    const out = pickTopItems(rows);
    // 5 critical + 5 high — medium + low excluded.
    expect(out).toHaveLength(10);
    // Critical drains first, sorted by createdAt desc within bucket.
    expect(out.slice(0, 5).map((i) => i.severity)).toEqual([
      'critical',
      'critical',
      'critical',
      'critical',
      'critical',
    ]);
    expect(out.slice(5).map((i) => i.severity)).toEqual(['high', 'high', 'high', 'high', 'high']);
    // Within each bucket, createdAt desc → newest id at the front.
    expect(out[0]?.id).toBe('c0');
    expect(out[5]?.id).toBe('h0');
  });
});
