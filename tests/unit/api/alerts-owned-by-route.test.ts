// @vitest-environment node
// Brief cases #1 + #4 — route handler test for the `?ownedByMe=1` chip
// on GET /api/alerts (mirror of tests/unit/api/alerts-since-route.test.ts
// — the lockstep tests for the `since` chip).
//   - case #1: ?ownedByMe=1 surfaces the active workspace member ID in the
//     composed Prisma `where` literal so a member sees only alerts they
//     own.
//   - case #2: missing `ownedByMe` key → no `ownerId` clause in `where`.
//   - case #3: `?ownedByMe=<other>` (typo/tampering) is hard-rejected
//     with 400 and the brief's exact error message.
//   - case #4: missing/no rows → AlertList envelope round-trips
//     `{ items: [], total: 0, page, pageSize, counts }`.
//
// Architecture mirror: the route delegates search and active-workspace
// resolution to helpers, so the test mocks those helpers along with Prisma
// and the existing member-role gate.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const alertFindMany = vi.fn();
const alertCount = vi.fn();
const alertGroupBy = vi.fn();
const cveEntryFindMany = vi.fn();
const alertCommentGroupBy = vi.fn();
const vulnerabilityTrendFindFirst = vi.fn();
const workspaceMemberFindMany = vi.fn();
const userFindMany = vi.fn();
const resolveDashboardWorkspaceContextMock = vi.fn();

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

vi.mock('@/lib/business/dashboard-workspace-context', () => ({
  resolveDashboardWorkspaceContext: resolveDashboardWorkspaceContextMock,
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
  resolveDashboardWorkspaceContextMock.mockReset();

  requireTeamRoleMock.mockResolvedValue(makeCtx());
  resolveDashboardWorkspaceContextMock.mockResolvedValue({
    workspaceId: 'team-1',
    workspaceMemberId: 'workspace-member-1',
  });
  alertGroupBy.mockResolvedValue([]);
  alertCommentGroupBy.mockResolvedValue([]);
  vulnerabilityTrendFindFirst.mockResolvedValue(null);
  workspaceMemberFindMany.mockResolvedValue([]);
  userFindMany.mockResolvedValue([]);
  cveEntryFindMany.mockResolvedValue([]);

  buildAlertSearchWhereMock.mockResolvedValue({});
  batchFetchAlertVulnerabilityTitlesMock.mockResolvedValue(new Map());
});

describe('GET /api/alerts — ?ownedByMe=1 chip', () => {
  it('?ownedByMe=1 uses the active workspace roster member ID in the findMany where', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    // Two `alertCount` calls now — the page-size `count({where})` plus
    // the snoozed count peer-read inside the same Promise.all. Mock
    // both slots so the route's parse envelope doesn't see an
    // unresolved call return.
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?ownedByMe=1'));
    expect(res.status).toBe(200);

    const findManyCall = alertFindMany.mock.calls[0][0] as {
      where: { ownerId?: { in: string[] } };
    };
    expect(findManyCall.where.ownerId).toEqual({ in: ['workspace-member-1'] });
  });

  it('no ?ownedByMe → the ownerId clause is NOT present in the where', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts'));
    expect(res.status).toBe(200);

    const findManyCall = alertFindMany.mock.calls[0][0] as {
      where: { ownerId?: { in: string[] } };
    };
    expect(findManyCall.where.ownerId).toBeUndefined();
  });

  it('?ownedByMe=other (typo / tampering) returns 400 with the brief-mandated message', async () => {
    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?ownedByMe=other'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toBe('ownedByMe must be "1"');
    // No DB read should have happened — the route rejects before the
    // prisma.findMany call.
    expect(alertFindMany).not.toHaveBeenCalled();
  });

  it('empty result set parses the AlertList envelope when ?ownedByMe=1 (brief case #4)', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?ownedByMe=1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(50);
    expect(body.counts).toEqual({ critical: 0, high: 0, medium: 0, low: 0, snoozed: 0 });
  });

  it('?ownedBy=me is ignored and still cannot widen beyond the active workspace', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?ownedBy=me'));
    expect(res.status).toBe(200);
    expect(alertFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ teamId: 'team-1' }),
      }),
    );
    expect(alertFindMany.mock.calls[0]?.[0]?.where).not.toHaveProperty('ownerId');
  });
});
