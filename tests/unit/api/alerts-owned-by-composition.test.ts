// @vitest-environment node
// Brief case #3 — composition test. Querying
// `?severity=critical&status=open&ownedByMe=1` must produce a Prisma
// `where` that combines all three filters:
//   - `severity: 'critical'` (the chip filter, top-level)
//   - `status: 'open'` (the chip filter, top-level)
//   - `ownerId: 'mem-1'` (the owned-by chip, top-level)
//
// Locks the "rows match the visible list 1:1" guarantee that the page
// relies on: a user with all three chip filters active sees exactly
// the rows the composed WHERE returns, no orphaned arm and no
// silently-dropped chip filter.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/business/dashboard-workspace-context', () => ({
  resolveDashboardWorkspaceContext: vi.fn().mockResolvedValue({
    workspaceId: 'team-1',
    workspaceMemberId: 'mem-1',
  }),
}));

const alertFindMany = vi.fn();
const alertCount = vi.fn();
const alertGroupBy = vi.fn();
const cveEntryFindMany = vi.fn();
const alertCommentGroupBy = vi.fn();
const vulnerabilityTrendFindFirst = vi.fn();
const workspaceMemberFindMany = vi.fn();
const userFindMany = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    alert: {
      findMany: alertFindMany,
      count: alertCount,
      groupBy: alertGroupBy,
    },
    alertComment: { groupBy: alertCommentGroupBy },
    cveEntry: { findMany: cveEntryFindMany },
    vulnerabilityTrend: { findFirst: vulnerabilityTrendFindFirst },
    workspaceMember: { findMany: workspaceMemberFindMany },
    user: { findMany: userFindMany },
  },
}));

const buildAlertSearchWhereMock = vi.fn();
const batchFetchAlertVulnerabilityTitlesMock = vi.fn();

vi.mock('@/lib/business/alerts-search', () => ({
  buildAlertSearchWhere: buildAlertSearchWhereMock,
  batchFetchAlertVulnerabilityTitles: batchFetchAlertVulnerabilityTitlesMock,
}));

const requireTeamRoleMock = vi.fn();

vi.mock('@/lib/team-auth', () => ({
  requireTeamRole: requireTeamRoleMock,
}));

function makeCtx() {
  return {
    user: {
      id: 'user-1',
      role: 'member',
      email: 'member@example.com',
      name: 'Member',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    membership: { id: 'mem-1', userId: 'user-1', teamId: 'team-1', role: 'member' },
    team: { id: 'team-1', name: 'system' },
  };
}

function makeRequest(url: string) {
  return new Request(url, { method: 'GET', headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  vi.resetModules();
  alertFindMany.mockReset();
  alertCount.mockReset();
  alertGroupBy.mockReset();
  cveEntryFindMany.mockReset();
  alertCommentGroupBy.mockReset();
  vulnerabilityTrendFindFirst.mockReset();
  workspaceMemberFindMany.mockReset();
  userFindMany.mockReset();
  buildAlertSearchWhereMock.mockReset();
  batchFetchAlertVulnerabilityTitlesMock.mockReset();
  requireTeamRoleMock.mockReset();

  requireTeamRoleMock.mockResolvedValue(makeCtx());
  alertGroupBy.mockResolvedValue([]);
  alertCommentGroupBy.mockResolvedValue([]);
  vulnerabilityTrendFindFirst.mockResolvedValue(null);
  workspaceMemberFindMany.mockResolvedValue([]);
  userFindMany.mockResolvedValue([]);
  cveEntryFindMany.mockResolvedValue([]);

  buildAlertSearchWhereMock.mockResolvedValue({});
  batchFetchAlertVulnerabilityTitlesMock.mockResolvedValue(new Map());
});

describe('GET /api/alerts — composition: ?severity=critical&status=open&ownedByMe=1', () => {
  it('merges severity + status + ownedByMe into the same where literal', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    // Two `alertCount` calls now — the page-size `count({where})` plus
    // the snoozed count peer-read inside the same Promise.all. Mock
    // both slots so the route's parse envelope doesn't see an
    // unresolved call return.
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(
      makeRequest('http://test/api/alerts?severity=critical&status=open&ownedByMe=1'),
    );
    expect(res.status).toBe(200);

    const findManyCall = alertFindMany.mock.calls[0][0] as {
      where: {
        severity?: string;
        status?: string;
        ownerId?: { in: string[] };
      };
    };
    expect(findManyCall.where.severity).toEqual({ in: ['critical'] });
    expect(findManyCall.where.status).toBe('open');
    // All three filters co-present in the SAME where literal — no
    // orphaned arm.
    expect(findManyCall.where.ownerId).toEqual({ in: ['mem-1'] });
  });

  // ===================== hideSnoozed (literal '1') composition =====================
  //
  // hideSnoozed's wire shape is the literal `'1'` (NOT `'true'`). Default
  // = snoozed rows visible (no OR arm); `?hideSnoozed=1` slices in the two
  // OR siblings `(snoozedUntil IS NULL OR snoozedUntil <= now)`. Locking
  // these assertions in the owned-by composition family proves the
  // severity/status/ownedByMe/hideSnoozed composition family agrees with the
  // lockstep arm shapes the brief calls out.

  it('no hideSnoozed param → OR arm is absent for the in-progress status filter', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(
      makeRequest('http://test/api/alerts?severity=critical&status=in_progress&ownedByMe=1'),
    );
    expect(res.status).toBe(200);

    const findManyCall = alertFindMany.mock.calls[0][0] as {
      where: {
        severity?: unknown;
        status?: string;
        ownerId?: { in: string[] };
        OR?: Array<Record<string, unknown>>;
      };
    };
    // `parseSeverityFilter` returns an array, so the route's severity
    // clause lands as `severity: { in: [...] }` even on a single-value
    // URL. Match the multi-select shape the router actually emits.
    expect(JSON.stringify(findManyCall.where.severity)).toBe(JSON.stringify({ in: ['critical'] }));
    expect(findManyCall.where.status).toBe('in_progress');
    expect(findManyCall.where.ownerId).toEqual({ in: ['mem-1'] });
    // hideSnoozed absent → no snooze arms. Snoozed rows surface by default.
    const hasSnoozedArm = (findManyCall.where.OR ?? []).some(
      (a) =>
        (a as { snoozedUntil?: unknown }).snoozedUntil === null ||
        typeof (a as { snoozedUntil?: { lte?: Date } }).snoozedUntil?.lte === 'object',
    );
    expect(hasSnoozedArm).toBe(false);
  });

  it('?hideSnoozed=1 splices the snooze OR arm alongside severity/status/ownedBy', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(
      makeRequest(
        'http://test/api/alerts?severity=critical&status=in_progress&ownedByMe=1&hideSnoozed=1',
      ),
    );
    expect(res.status).toBe(200);

    const findManyCall = alertFindMany.mock.calls[0][0] as {
      where: {
        severity?: unknown;
        status?: string;
        ownerId?: { in: string[] };
        OR?: Array<Record<string, unknown>>;
      };
    };
    expect(JSON.stringify(findManyCall.where.severity)).toBe(JSON.stringify({ in: ['critical'] }));
    expect(findManyCall.where.status).toBe('in_progress');
    expect(findManyCall.where.ownerId).toEqual({ in: ['mem-1'] });
    // hideSnoozed=on → the two snooze arms hoist up alongside the
    // sibling filters.
    const orArms = findManyCall.where.OR ?? [];
    const nullArm = orArms.find((a) => (a as { snoozedUntil?: unknown }).snoozedUntil === null);
    const lteArm = orArms.find(
      (a) =>
        typeof (a as { snoozedUntil?: { lte?: Date } }).snoozedUntil?.lte === 'object' &&
        (a as { snoozedUntil?: { lte?: Date } }).snoozedUntil?.lte instanceof Date,
    );
    expect(nullArm).toBeDefined();
    expect(lteArm).toBeDefined();
  });
});
