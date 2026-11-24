// Two-arm derivation test for src/lib/business/alerts-activity.ts.
// Pins each branch of `MAX(MAX(AlertNote.createdAt), remediatedAt)`
// for the list + detail helpers so a future drift away from the
// "return `null` on neither-input-set" contract breaks here.
//
// Setup mirrors the existing helper-test posture: mock 'server-only'
// so the module loads under vitest, mock '@/lib/db' with a
// swappable `prisma.alertNote.groupBy` whose behavior each test
// overrides. The team-scope `alert: { teamId }` join is verified
// across both helpers via the same call-site assertions.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

type GroupByArgs = {
  where: { alertId: string | { in: string[] }; alert: { teamId: string } };
};
type GroupByResponse = Array<{ alertId: string; _max: { createdAt: Date | null } }>;

const groupByMock = vi.fn<[GroupByArgs], Promise<GroupByResponse>>();

vi.mock('@/lib/db', () => ({
  get prisma() {
    return {
      alertNote: {
        groupBy: (...args: [GroupByArgs]) => groupByMock(...args),
      },
    };
  },
}));

import {
  computeAlertLastActivityAtForList,
  computeAlertLastActivityAtForOne,
} from '@/lib/business/alerts-activity';

const TEAM = 'team-1';
const REMEDIATED = new Date('2026-01-10T00:00:00.000Z');
const CREATED = new Date('2026-01-01T00:00:00.000Z');

beforeEach(() => {
  groupByMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('computeAlertLastActivityAtForList — two-arm derivation', () => {
  it('returns noteMax when noteMax > remediatedAt', async () => {
    const noteMax = new Date('2026-02-01T00:00:00.000Z');
    groupByMock.mockResolvedValueOnce([{ alertId: 'a1', _max: { createdAt: noteMax } }]);
    const rows = [{ id: 'a1', remediatedAt: REMEDIATED, createdAt: CREATED }];
    const out = await computeAlertLastActivityAtForList(rows, TEAM);
    expect(out.get('a1')?.toISOString()).toBe(noteMax.toISOString());
    // Team-scope join assertion:
    expect(groupByMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          alert: { teamId: TEAM },
          alertId: { in: ['a1'] },
        }),
      }),
    );
  });

  it('returns remediatedAt when remediatedAt > noteMax', async () => {
    const noteMax = new Date('2026-01-05T00:00:00.000Z');
    groupByMock.mockResolvedValueOnce([{ alertId: 'a1', _max: { createdAt: noteMax } }]);
    const rows = [{ id: 'a1', remediatedAt: REMEDIATED /* 01-10 */, createdAt: CREATED }];
    const out = await computeAlertLastActivityAtForList(rows, TEAM);
    expect(out.get('a1')?.toISOString()).toBe(REMEDIATED.toISOString());
  });

  it('returns remediatedAt when noteMax is null', async () => {
    groupByMock.mockResolvedValueOnce([{ alertId: 'a1', _max: { createdAt: null } }]);
    const rows = [{ id: 'a1', remediatedAt: REMEDIATED, createdAt: CREATED }];
    const out = await computeAlertLastActivityAtForList(rows, TEAM);
    expect(out.get('a1')?.toISOString()).toBe(REMEDIATED.toISOString());
  });

  it('returns null when both noteMax and remediatedAt are null (cold-start branch)', async () => {
    // Brand-new row with no handoff notes AND no remediation stamp:
    // the helper must NOT invent a date from `createdAt` — the wire
    // stamps `lastActivityAt: null` and the UI's em-dash placeholder
    // fires. The comparator falls back to `createdAt` on the sort
    // key, NOT the helper.
    groupByMock.mockResolvedValueOnce([{ alertId: 'a1', _max: { createdAt: null } }]);
    const rows = [{ id: 'a1', remediatedAt: null, createdAt: CREATED }];
    const out = await computeAlertLastActivityAtForList(rows, TEAM);
    expect(out.has('a1')).toBe(true);
    expect(out.get('a1')).toBeNull();
  });

  it('returns null when groupBy returns no row for the alert', async () => {
    // No note rows for this alert at all — the cold-start branch
    // must surface null (no fallback to createdAt here).
    groupByMock.mockResolvedValueOnce([]);
    const rows = [{ id: 'a1', remediatedAt: null, createdAt: CREATED }];
    const out = await computeAlertLastActivityAtForList(rows, TEAM);
    expect(out.has('a1')).toBe(true);
    expect(out.get('a1')).toBeNull();
  });

  it('resolves mixed rows in a single batch (one with notes, one cold-start)', async () => {
    const noteMax = new Date('2026-02-15T00:00:00.000Z');
    groupByMock.mockResolvedValueOnce([{ alertId: 'with-note', _max: { createdAt: noteMax } }]);
    const created1 = new Date('2026-01-01T00:00:00.000Z');
    const created2 = new Date('2026-03-01T00:00:00.000Z');
    const rows = [
      { id: 'with-note', remediatedAt: null, createdAt: created1 },
      { id: 'cold-start', remediatedAt: REMEDIATED, createdAt: created2 },
    ];
    const out = await computeAlertLastActivityAtForList(rows, TEAM);
    // with-note: picks noteMax
    expect(out.get('with-note')?.toISOString()).toBe(noteMax.toISOString());
    // cold-start: remediatedAt is set, picks that (no notes)
    expect(out.get('cold-start')?.toISOString()).toBe(REMEDIATED.toISOString());
  });

  it('returns an empty map when the row list is empty (no DB read)', async () => {
    const out = await computeAlertLastActivityAtForList([], TEAM);
    expect(out.size).toBe(0);
    expect(groupByMock).not.toHaveBeenCalled();
  });
});

describe('computeAlertLastActivityAtForOne — two-arm derivation', () => {
  it('returns noteMax when noteMax > remediatedAt', async () => {
    const noteMax = new Date('2026-02-01T00:00:00.000Z');
    groupByMock.mockResolvedValueOnce([{ alertId: 'a1', _max: { createdAt: noteMax } }]);
    const out = await computeAlertLastActivityAtForOne('a1', REMEDIATED, CREATED, TEAM);
    expect(out?.toISOString()).toBe(noteMax.toISOString());
    expect(groupByMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ alert: { teamId: TEAM }, alertId: 'a1' }),
      }),
    );
  });

  it('returns remediatedAt when remediatedAt > noteMax', async () => {
    const noteMax = new Date('2026-01-05T00:00:00.000Z');
    groupByMock.mockResolvedValueOnce([{ alertId: 'a1', _max: { createdAt: noteMax } }]);
    const out = await computeAlertLastActivityAtForOne('a1', REMEDIATED, CREATED, TEAM);
    expect(out?.toISOString()).toBe(REMEDIATED.toISOString());
  });

  it('returns remediatedAt when noteMax is null', async () => {
    groupByMock.mockResolvedValueOnce([{ alertId: 'a1', _max: { createdAt: null } }]);
    const out = await computeAlertLastActivityAtForOne('a1', REMEDIATED, CREATED, TEAM);
    expect(out?.toISOString()).toBe(REMEDIATED.toISOString());
  });

  it('returns null when both noteMax and remediatedAt are null (cold-start branch)', async () => {
    groupByMock.mockResolvedValueOnce([{ alertId: 'a1', _max: { createdAt: null } }]);
    const out = await computeAlertLastActivityAtForOne('a1', null, CREATED, TEAM);
    expect(out).toBeNull();
  });

  it('returns null when groupBy returns no row for the alert', async () => {
    groupByMock.mockResolvedValueOnce([]);
    const out = await computeAlertLastActivityAtForOne('a1', null, CREATED, TEAM);
    expect(out).toBeNull();
  });
});
