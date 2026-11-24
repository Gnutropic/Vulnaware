// @vitest-environment node
// Brief case #3 — composition test. Querying `?severity=critical&status=in_progress&since=7d`
// must produce a Prisma `where` that combines all three filters:
//   - `severity: 'critical'` (the chip filter)
//   - `status: 'in_progress'` (the chip filter)
//   - the OR'd `since` bound (createdAt + statusChangedAt arms)
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

describe('GET /api/alerts — composition: ?severity=critical&status=in_progress&since=7d', () => {
  it('merges severity + status + since into the same where literal', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(
      makeRequest('http://test/api/alerts?severity=critical&status=in_progress&since=7d'),
    );
    expect(res.status).toBe(200);

    const findManyCall = alertFindMany.mock.calls[0][0] as {
      where: {
        severity?: string;
        status?: string;
        OR?: Array<Record<string, unknown>>;
      };
    };
    expect(findManyCall.where.severity).toEqual({ in: ['critical'] });
    expect(findManyCall.where.status).toBe('in_progress');

    // The since arms are present in the OR list (createdAt-gte AND
    // statusChangedAt-gte). The page's chip-state asserts that
    // "Critical + Status: open + Last 7 days" surfaces the same row set
    // as the SQL query.
    const arms = findManyCall.where.OR ?? [];
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
    expect(createdAtArm).toBeDefined();
    expect(statusChangedAtArm).toBeDefined();
  });
});
