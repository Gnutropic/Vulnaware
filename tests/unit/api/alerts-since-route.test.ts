// @vitest-environment node
// Brief cases #1 + #4 — route handler test for the `?since=7d` chip on
// GET /api/alerts.
//   - case #1: ?since=7d surfaces a composite Prisma OR clause that
//     queries `createdAt >= bound` AND `statusChangedAt >= bound` over
//     a shared `Date` bound.
//   - case #4: an empty result set (zero rows returned) parses the
//     `AlertList` envelope shape correctly — `{ items: [], total: 0,
//     page, pageSize, counts }` round-trips a 200 with the contract's
//     default counts.
//
// Architecture mirror: the route delegates search to
// `@/lib/business/alerts-search`, so we mock `@/lib/db`, that helper,
// and `@/lib/team-auth`. Single new dependency:
// `@/lib/business/alerts-since` is exercised through the route's
// composed `where` (we read call args directly).

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

// Inspect the OR-list and isolate the two `since` arms (createdAt-gte
// + statusChangedAt-gte) so the assertion survives the snooze arms
// that the default-hide snooze clause also contributes to the same
// top-level OR.
function sinceArms(where: { OR?: Array<Record<string, unknown>> }) {
  const arms = where.OR ?? [];
  const createdAtArm = arms.find(
    (a) =>
      (a as { createdAt?: { gte?: Date } }).createdAt?.gte instanceof Date &&
      (a as { statusChangedAt?: object }).statusChangedAt === undefined,
  );
  const statusChangedAtArm = arms.find(
    (a) =>
      (a as { statusChangedAt?: { gte?: Date } }).statusChangedAt?.gte instanceof Date &&
      (a as { createdAt?: object }).createdAt === undefined,
  );
  return { createdAtArm, statusChangedAtArm };
}

describe('GET /api/alerts — ?since=7d chip', () => {
  it("since=7d surfaces the OR'd createdAt/statusChangedAt clause in the findMany where", async () => {
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?since=7d'));
    expect(res.status).toBe(200);

    const findManyCall = alertFindMany.mock.calls[0][0] as {
      where: { OR?: Array<Record<string, unknown>> };
    };
    const { createdAtArm, statusChangedAtArm } = sinceArms(findManyCall.where);
    expect(createdAtArm).toBeDefined();
    expect(statusChangedAtArm).toBeDefined();

    const createdAtBound = (createdAtArm as { createdAt: { gte: Date } }).createdAt.gte;
    const statusChangedAtBound = (statusChangedAtArm as { statusChangedAt: { gte: Date } })
      .statusChangedAt.gte;
    expect(createdAtBound.getTime()).toBe(statusChangedAtBound.getTime());
  });

  it('no since= → the since arms are NOT present in the where.OR', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts'));
    expect(res.status).toBe(200);

    const findManyCall = alertFindMany.mock.calls[0][0] as {
      where: { OR?: Array<Record<string, unknown>> };
    };
    const { createdAtArm, statusChangedAtArm } = sinceArms(findManyCall.where);
    expect(createdAtArm).toBeUndefined();
    expect(statusChangedAtArm).toBeUndefined();
  });

  it('since=8d (typo, outside enum) returns 400 through AlertQuery', async () => {
    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?since=8d'));
    expect(res.status).toBe(400);
  });

  it('empty result set parses the AlertList envelope (brief case #4)', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?since=7d'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(50);
    expect(body.counts).toEqual({ critical: 0, high: 0, medium: 0, low: 0, snoozed: 0 });
  });
});

// ===================== hideSnoozed gate (literal '1') =====================
//
// hideSnoozed's wire shape is the literal `'1'` (NOT `'true'`). Default
// = snoozed rows visible (no OR arm); `?hideSnoozed=1` slices in the two
// OR siblings `(snoozedUntil IS NULL OR snoozedUntil <= now)`. Locking
// these assertions in the since-route family proves the since + hideSnoozed
// composition family agrees with the lockstep arm shapes the brief calls
// out.

describe('GET /api/alerts — ?hideSnoozed=1 (since-route composition family)', () => {
  it('no hideSnoozed param → snooze OR arm is NOT present; since arms remain unchanged', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?since=7d'));
    expect(res.status).toBe(200);

    const findManyCall = alertFindMany.mock.calls[0]?.[0] as {
      where: { OR?: Array<Record<string, unknown>> } | undefined;
    };
    const orArms = findManyCall?.where?.OR ?? [];
    // since arms still hoist up regardless of hideSnoozed.
    const { createdAtArm, statusChangedAtArm } = sinceArms(findManyCall?.where ?? {});
    expect(createdAtArm).toBeDefined();
    expect(statusChangedAtArm).toBeDefined();
    // hideSnoozed absent → no snooze arms. Snoozed rows surface by default.
    const hasSnoozedArm = orArms.some(
      (a) =>
        (a as { snoozedUntil?: unknown }).snoozedUntil === null ||
        typeof (a as { snoozedUntil?: { lte?: Date } }).snoozedUntil?.lte === 'object',
    );
    expect(hasSnoozedArm).toBe(false);
  });

  it('since=7d + hideSnoozed=1 → since arms + hide-snooze arms co-present in the same where.OR', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?since=7d&hideSnoozed=1'));
    expect(res.status).toBe(200);

    const findManyCall = alertFindMany.mock.calls[0]?.[0] as {
      where: { OR?: Array<Record<string, unknown>> } | undefined;
    };
    const orArms = findManyCall?.where?.OR ?? [];
    // since arms still hoist up alongside the hide-snooze arms.
    const { createdAtArm, statusChangedAtArm } = sinceArms(findManyCall?.where ?? {});
    expect(createdAtArm).toBeDefined();
    expect(statusChangedAtArm).toBeDefined();
    // hideSnoozed=on → the two snooze arms are spliced in.
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
