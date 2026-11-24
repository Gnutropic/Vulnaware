// @vitest-environment node
// Unit tests for GET /api/alerts and the team-scoped posture.
// Mirrors audit-event-route.test.ts with the alerts domain swap.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const alertFindMany = vi.fn();
const alertCount = vi.fn();
const alertGroupBy = vi.fn();
const alertCreate = vi.fn();
const cveEntryFindMany = vi.fn();
const alertCommentGroupBy = vi.fn();
const vulnerabilityTrendFindFirst = vi.fn();
const workspaceMemberFindMany = vi.fn();
const userFindMany = vi.fn();
const resolveDashboardWorkspaceContextMock = vi.fn();
const computeAlertLastActivityAtForListMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    alert: {
      findMany: alertFindMany,
      count: alertCount,
      groupBy: alertGroupBy,
      create: alertCreate,
    },
    scan: { findMany: vi.fn() },
    alertComment: { groupBy: alertCommentGroupBy },
    cveEntry: { findMany: cveEntryFindMany },
    vulnerabilityTrend: { findFirst: vulnerabilityTrendFindFirst },
    workspaceMember: { findMany: workspaceMemberFindMany },
    user: { findMany: userFindMany },
  },
}));

// Mirror the search-helper mock pattern from alerts-since-route.test.ts
// so the route's `buildAlertSearchWhere(q)` + title peer-read resolve
// without throwing inside the team's try/catch. The handler only calls
// the helpers when `q` is set, but the mock keeps every call site
// honest.
const buildAlertSearchWhereMock = vi.fn();
const batchFetchAlertVulnerabilityTitlesMock = vi.fn();

vi.mock('@/lib/business/alerts-search', () => ({
  buildAlertSearchWhere: buildAlertSearchWhereMock,
  batchFetchAlertVulnerabilityTitles: batchFetchAlertVulnerabilityTitlesMock,
}));

vi.mock('@/lib/business/alerts-activity', () => ({
  computeAlertLastActivityAtForList: computeAlertLastActivityAtForListMock,
}));

// Swappable mock for requireTeamRole so individual tests can swap the
// implementation without invoking vi.doMock (whose registration is not
// undone by vi.resetModules and leaks across tests).
const requireTeamRoleMock = vi.fn();
// Default successful member context — replaced per-test as needed.
requireTeamRoleMock.mockResolvedValue({
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
});

vi.mock('@/lib/team-auth', () => ({
  requireTeamRole: requireTeamRoleMock,
}));

vi.mock('@/lib/business/dashboard-workspace-context', () => ({
  resolveDashboardWorkspaceContext: resolveDashboardWorkspaceContextMock,
}));

function makeAlert(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-1',
    teamId: 'active-workspace-1',
    findingId: 'finding-1',
    severity: 'high',
    status: 'open',
    source: 'kev',
    assigneeId: null,
    ownerId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    acknowledgedAt: null,
    ...overrides,
  };
}

function makeAlertWithHost(
  id: string,
  severity: string | null,
  host: string,
  createdAt: string,
) {
  return makeAlert({
    id,
    severity,
    createdAt: new Date(createdAt),
    finding: {
      cveId: `CVE-${id}`,
      priorityScore: 7,
      asset: { host, port: 443, protocol: 'tcp', scan: { teamId: 'active-workspace-1' } },
      scan: { source: 'manual' },
    },
  });
}

function makeRequest(url: string) {
  return new Request(url, { method: 'GET', headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  vi.resetModules();
  alertFindMany.mockReset();
  alertCount.mockReset();
  alertGroupBy.mockReset();
  alertCreate.mockReset();
  cveEntryFindMany.mockReset();
  alertCommentGroupBy.mockReset();
  vulnerabilityTrendFindFirst.mockReset();
  workspaceMemberFindMany.mockReset();
  userFindMany.mockReset();
  resolveDashboardWorkspaceContextMock.mockReset();
  buildAlertSearchWhereMock.mockReset();
  batchFetchAlertVulnerabilityTitlesMock.mockReset();
  computeAlertLastActivityAtForListMock.mockReset();
  // The /api/alerts handler also Issues a parallel severity-groupBy call to
  // power the count badges. Default it to "no rows" so the 200-path tests
  // still parse a Counts object successfully — tests that care about the
  // badges override this per-test.
  alertGroupBy.mockResolvedValue([]);
  alertCommentGroupBy.mockResolvedValue([]);
  vulnerabilityTrendFindFirst.mockResolvedValue(null);
  workspaceMemberFindMany.mockResolvedValue([]);
  userFindMany.mockResolvedValue([]);
  cveEntryFindMany.mockResolvedValue([]);
  buildAlertSearchWhereMock.mockResolvedValue({});
  batchFetchAlertVulnerabilityTitlesMock.mockResolvedValue(new Map());
  computeAlertLastActivityAtForListMock.mockResolvedValue(new Map());
  requireTeamRoleMock.mockReset();
  requireTeamRoleMock.mockResolvedValue({
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
  });
  resolveDashboardWorkspaceContextMock.mockResolvedValue({
    workspaceId: 'active-workspace-1',
    workspaceMemberId: 'active-workspace-member-1',
  });
});

// ===================== GET /api/alerts =====================

describe('GET /api/alerts', () => {
  it('returns paginated items for a member', async () => {
    alertFindMany.mockResolvedValueOnce([makeAlert()]);
    // Two `alertCount` calls now — the page-size `count({where})` plus
    // the snoozed count peer-read inside the same Promise.all. The
    // first slot returns 1 (the page-total count) and the second
    // returns 0 (the snoozed peer-read). The widened envelope
    // (counts.snoozed) is asserted below to pin the wire-shape.
    alertCount.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(50);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('alert-1');
    expect(body.items[0].source).toBe('kev');
    // Widened counts envelope — the snoozed peer-read rides the same
    // "how many will I see if I click me" invariant as the severity
    // groupBy above. The badge widens to five slots (4 severity + 1
    // snoozed) so a future drift away from the peer-read shape
    // breaks here.
    expect(body.counts.snoozed).toBe(0);
  });

  it.each(['workspaceId=foreign-workspace', 'teamId=foreign-team'])(
    'rejects client-supplied workspace scope: %s',
    async (scopeParam) => {
      const { GET } = await import('@/app/api/alerts/route');
      const res = await GET(makeRequest(`http://test/api/alerts?${scopeParam}`));

      expect(res.status).toBe(400);
      expect(alertFindMany).not.toHaveBeenCalled();
    },
  );

  it('includes both selected calendar days in createdAt filtering and composes with other filters', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValue(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(
      makeRequest(
        'http://test/api/alerts?from=2026-10-10&to=2026-10-11&status=in_progress&severity=high&hostname=api.example&sort=created_asc&page=2&pageSize=1',
      ),
    );

    expect(res.status).toBe(200);
    const dateFilter = {
      gte: new Date('2026-10-10T00:00:00.000Z'),
      lt: new Date('2026-10-12T00:00:00.000Z'),
    };
    expect(alertFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: 'active-workspace-1',
          status: 'in_progress',
          severity: { in: ['high'] },
          createdAt: dateFilter,
        }),
        skip: 1,
        take: 1,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
    expect(alertCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: 'active-workspace-1',
          status: 'in_progress',
          severity: { in: ['high'] },
          createdAt: dateFilter,
        }),
      }),
    );
  });

  it.each([
    ['from=2026-02-30', 'invalid calendar date'],
    ['from=2026-10-12&to=2026-10-11', 'reversed date range'],
    ['from=2026-10-10T09%3A00%3A00', 'timestamp without an explicit timezone'],
  ])('rejects %s before reading alerts (%s)', async (query) => {
    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest(`http://test/api/alerts?${query}`));

    expect(res.status).toBe(400);
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertCount).not.toHaveBeenCalled();
  });

  it('returns unresolved counts for every severity without pagination or sort affecting totals', async () => {
    alertFindMany.mockResolvedValueOnce([
      makeAlert({ id: 'critical-alert', severity: 'critical' }),
      makeAlert({ id: 'high-alert', severity: 'high' }),
      makeAlert({ id: 'medium-alert', severity: 'medium' }),
      makeAlert({ id: 'low-alert', severity: 'low' }),
    ]);
    alertCount.mockResolvedValueOnce(4).mockResolvedValueOnce(0);
    alertGroupBy
      .mockResolvedValueOnce([
        { severity: 'critical', _count: 1 },
        { severity: 'high', _count: 1 },
        { severity: 'medium', _count: 1 },
        { severity: 'low', _count: 1 },
      ])
      .mockResolvedValueOnce([]);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?page=2&pageSize=1&sort=created_asc'));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      total: 4,
      page: 2,
      pageSize: 1,
      counts: { critical: 1, high: 1, medium: 1, low: 1 },
    });
    expect(alertGroupBy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: 'active-workspace-1',
          status: { not: 'resolved' },
        }),
        by: ['severity'],
      }),
    );
    expect(alertGroupBy.mock.calls[0]?.[0]).not.toHaveProperty('skip');
    expect(alertGroupBy.mock.calls[0]?.[0]).not.toHaveProperty('take');
    expect(alertGroupBy.mock.calls[0]?.[0]).not.toHaveProperty('orderBy');
  });

  it('keeps every page and its totals scoped to the active workspace', async () => {
    const fixtures = [
      makeAlert({
        id: 'active-1',
        status: 'in_progress',
        severity: 'high',
        createdAt: new Date('2026-10-10T12:00:00Z'),
        snoozedUntil: new Date('2027-01-01T00:00:00Z'),
      }),
      makeAlert({
        id: 'active-2',
        status: 'in_progress',
        severity: 'high',
        createdAt: new Date('2026-10-11T12:00:00Z'),
      }),
      makeAlert({
        id: 'active-3',
        status: 'in_progress',
        severity: 'high',
        createdAt: new Date('2026-10-12T12:00:00Z'),
      }),
      makeAlert({
        id: 'active-low',
        status: 'in_progress',
        severity: 'low',
        createdAt: new Date('2026-10-12T13:00:00Z'),
        snoozedUntil: new Date('2027-01-01T00:00:00Z'),
      }),
      makeAlert({
        id: 'foreign-workspace',
        teamId: 'another-workspace',
        status: 'in_progress',
        severity: 'high',
        createdAt: new Date('2026-10-11T12:00:00Z'),
        snoozedUntil: new Date('2027-01-01T00:00:00Z'),
      }),
    ];
    const matchesScopeAndFilters = (
      row: (typeof fixtures)[number],
      where: Record<string, unknown>,
    ) => {
      if (row.teamId !== where.teamId) return false;
      if (typeof where.status === 'string' && row.status !== where.status) return false;
      const severity = where.severity as { in?: string[] } | undefined;
      if (severity?.in && !severity.in.includes(String(row.severity))) return false;
      const createdAt = where.createdAt as { gte?: Date; lt?: Date } | undefined;
      if (createdAt?.gte && row.createdAt < createdAt.gte) return false;
      if (createdAt?.lt && row.createdAt >= createdAt.lt) return false;
      const snoozedUntil = where.snoozedUntil as { gt?: Date } | undefined;
      if (snoozedUntil?.gt && !(row.snoozedUntil instanceof Date && row.snoozedUntil > snoozedUntil.gt)) {
        return false;
      }
      return true;
    };

    alertFindMany.mockImplementation(async (args) => {
      const where = (args.where ?? {}) as Record<string, unknown>;
      const filtered = fixtures
        .filter((row) => matchesScopeAndFilters(row, where))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const skip = args.skip ?? 0;
      return filtered.slice(skip, skip + (args.take ?? filtered.length));
    });
    alertCount.mockImplementation(async (args) => {
      const where = (args.where ?? {}) as Record<string, unknown>;
      return fixtures.filter((row) => matchesScopeAndFilters(row, where)).length;
    });
    alertGroupBy.mockImplementation(async (args) => {
      const where = (args.where ?? {}) as Record<string, unknown>;
      const matching = fixtures.filter((row) => matchesScopeAndFilters(row, where));
      const grouped = new Map<string, number>();
      for (const row of matching) {
        const severity = String(row.severity ?? '');
        grouped.set(severity, (grouped.get(severity) ?? 0) + 1);
      }
      return [...grouped].map(([severity, count]) => ({ severity, _count: count }));
    });
    buildAlertSearchWhereMock.mockResolvedValue({
      finding: { OR: [{ cveId: { contains: 'needle', mode: 'insensitive' } }] },
    });

    const { GET } = await import('@/app/api/alerts/route');
    const query =
      'q=needle&hostname=api.example&status=in_progress&severity=high&from=2026-10-10&to=2026-10-12&sort=created_asc&pageSize=1';
    const expectedCounts = { critical: 0, high: 3, medium: 0, low: 0, snoozed: 2 };

    for (const [page, expectedIds] of [
      [1, ['active-1']],
      [2, ['active-2']],
      [3, ['active-3']],
    ] as const) {
      const response = await GET(makeRequest(`http://test/api/alerts?${query}&page=${page}`));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ page, total: 3, pageSize: 1, counts: expectedCounts });
      expect(body.items.map((item: { id: string }) => item.id)).toEqual(expectedIds);
      expect(body.items.every((item: { teamId: string }) => item.teamId === 'active-workspace-1')).toBe(
        true,
      );
    }

    // A larger page size makes the same active result set a single-page
    // view; both navigation controls derive their disabled state from this
    // response's page, total and pageSize.
    const singlePageResponse = await GET(
      makeRequest(
        `http://test/api/alerts?${query.replace('pageSize=1', 'pageSize=50')}&page=1`,
      ),
    );
    const singlePageBody = await singlePageResponse.json();
    expect(singlePageBody).toMatchObject({
      page: 1,
      total: 3,
      pageSize: 50,
      counts: expectedCounts,
    });
    expect(singlePageBody.items.map((item: { id: string }) => item.id)).toEqual([
      'active-1',
      'active-2',
      'active-3',
    ]);

    for (const [args] of alertFindMany.mock.calls) {
      expect(args.where).toEqual(
        expect.objectContaining({
          teamId: 'active-workspace-1',
          status: 'in_progress',
          severity: { in: ['high'] },
          createdAt: {
            gte: new Date('2026-10-10T00:00:00.000Z'),
            lt: new Date('2026-10-13T00:00:00.000Z'),
          },
        }),
      );
    }
    for (const [args] of alertCount.mock.calls) {
      expect(args.where).toEqual(expect.objectContaining({ teamId: 'active-workspace-1' }));
    }
    for (const [args] of alertGroupBy.mock.calls) {
      expect(args.where).toEqual(expect.objectContaining({ teamId: 'active-workspace-1' }));
    }

    const alertReadsBeforeTampering = alertFindMany.mock.calls.length;
    const tamperedResponse = await GET(
      makeRequest(`http://test/api/alerts?${query}&page=2&workspaceId=another-workspace`),
    );
    expect(tamperedResponse.status).toBe(400);
    expect(alertFindMany).toHaveBeenCalledTimes(alertReadsBeforeTampering);
  });

  it('applies the same unresolved search and filter predicate to severity counts', async () => {
    alertFindMany.mockResolvedValueOnce([
      makeAlert({ id: 'filtered-critical', severity: 'critical' }),
    ]);
    alertCount.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    alertGroupBy
      .mockResolvedValueOnce([{ severity: 'critical', _count: 1 }])
      .mockResolvedValueOnce([]);
    buildAlertSearchWhereMock.mockResolvedValueOnce({
      finding: { OR: [{ cveId: { contains: 'needle', mode: 'insensitive' } }] },
    });

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(
      makeRequest('http://test/api/alerts?q=needle&source=kev&severity=critical'),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      total: 1,
      counts: { critical: 1, high: 0, medium: 0, low: 0 },
    });
    expect(alertGroupBy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: 'active-workspace-1',
          source: 'kev',
          severity: { in: ['critical'] },
          status: { not: 'resolved' },
          finding: { OR: [{ cveId: { contains: 'needle', mode: 'insensitive' } }] },
        }),
      }),
    );
  });

  it('maps finite finding risk scores and omits unavailable scores', async () => {
    alertFindMany.mockResolvedValueOnce([
      makeAlert({
        id: 'alert-scored',
        finding: {
          cveId: 'CVE-2026-0001',
          priorityScore: 8.125,
          asset: { host: 'app.example.test', port: 443, protocol: 'tcp' },
          scan: { source: 'scheduled' },
        },
      }),
      makeAlert({
        id: 'alert-null-score',
        finding: {
          cveId: 'CVE-2026-0002',
          priorityScore: null,
          asset: { host: 'db.example.test', port: 5432, protocol: 'tcp' },
          scan: { source: 'manual' },
        },
      }),
      makeAlert({ id: 'alert-no-finding', finding: null }),
    ]);
    alertCount.mockResolvedValueOnce(3).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'alert-scored',
          asset: expect.objectContaining({ riskScore: 8.125 }),
        }),
        expect.objectContaining({
          id: 'alert-null-score',
          asset: expect.objectContaining({ riskScore: null }),
        }),
        expect.objectContaining({
          id: 'alert-no-finding',
          asset: expect.objectContaining({ riskScore: null }),
        }),
      ]),
    );
    expect(alertFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          finding: expect.objectContaining({
            select: expect.objectContaining({ priorityScore: true }),
          }),
        }),
      }),
    );
  });

  it('derives asset detail links only for assets scanned in the active workspace', async () => {
    alertFindMany.mockResolvedValueOnce([
      makeAlert({
        id: 'alert-authorized-asset',
        finding: {
          cveId: 'CVE-2026-0001',
          priorityScore: 8.125,
          asset: {
            host: 'app.example.test',
            port: 443,
            protocol: 'tcp',
            scan: { teamId: 'active-workspace-1' },
          },
          scan: { source: 'scheduled' },
        },
      }),
      makeAlert({
        id: 'alert-unauthorized-asset',
        finding: {
          cveId: 'CVE-2026-0002',
          priorityScore: 4,
          asset: {
            host: 'other.example.test',
            port: 443,
            protocol: 'tcp',
            scan: { teamId: 'other-workspace' },
          },
          scan: { source: 'manual' },
        },
      }),
    ]);
    alertCount.mockResolvedValueOnce(2).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'alert-authorized-asset',
          asset: expect.objectContaining({
            detailHref: '/assets/app.example.test',
          }),
        }),
        expect.objectContaining({
          id: 'alert-unauthorized-asset',
          asset: expect.not.objectContaining({ detailHref: expect.anything() }),
        }),
      ]),
    );
    expect(alertFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ teamId: 'active-workspace-1' }),
        include: expect.objectContaining({
          finding: expect.objectContaining({
            select: expect.objectContaining({
              asset: {
                select: expect.objectContaining({
                  scan: { select: { teamId: true } },
                }),
              },
            }),
          }),
        }),
      }),
    );
  });

  it('always seeds alert reads with the validated active workspace (not the default team)', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    // The active workspace differs from the default team in the auth context.
    // URL-supplied team IDs cannot widen or redirect the scope.
    const res = await GET(makeRequest('http://test/api/alerts?severity=critical'));
    expect(res.status).toBe(200);
    expect(alertFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ teamId: 'active-workspace-1' }),
      }),
    );
  });

  it('filters high-risk associated findings at the inclusive threshold in list and count queries', async () => {
    alertFindMany.mockResolvedValue([]);
    alertCount.mockResolvedValue(0);
    buildAlertSearchWhereMock.mockResolvedValue({
      finding: { OR: [{ cveId: { contains: 'log4j', mode: 'insensitive' } }] },
    });

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(
      makeRequest(
        'http://test/api/alerts?highRiskAssets=1&q=log4j&severity=critical&sort=created_asc',
      ),
    );

    expect(res.status).toBe(200);
    expect(alertFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: 'active-workspace-1',
          severity: { in: ['critical'] },
          finding: {
            OR: [{ cveId: { contains: 'log4j', mode: 'insensitive' } }],
            priorityScore: { gte: 7 },
          },
        }),
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );

    for (const call of alertCount.mock.calls) {
      expect(call[0]?.where).toEqual(
        expect.objectContaining({
          teamId: 'active-workspace-1',
          finding: expect.objectContaining({ priorityScore: { gte: 7 } }),
        }),
      );
    }
    expect(alertGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: 'active-workspace-1',
          finding: expect.objectContaining({ priorityScore: { gte: 7 } }),
        }),
      }),
    );
  });

  it('does not add a score predicate when highRiskAssets is absent', async () => {
    alertFindMany.mockResolvedValue([]);
    alertCount.mockResolvedValue(0);
    buildAlertSearchWhereMock.mockResolvedValue({
      finding: { OR: [{ cveId: { contains: 'legacy', mode: 'insensitive' } }] },
    });

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(
      makeRequest('http://test/api/alerts?q=legacy&severity=high&sort=created_asc'),
    );

    expect(res.status).toBe(200);
    const listWhere = alertFindMany.mock.calls.at(-1)?.[0]?.where as Record<string, unknown>;
    expect(listWhere.teamId).toBe('active-workspace-1');
    expect(listWhere.severity).toEqual({ in: ['high'] });
    expect(listWhere.finding).toEqual({
      OR: [{ cveId: { contains: 'legacy', mode: 'insensitive' } }],
    });
    for (const call of alertCount.mock.calls) {
      expect(call[0]?.where).not.toHaveProperty('finding.priorityScore');
    }
  });

  it.each([
    ['all', undefined],
    ['unresolved', { not: 'resolved' }],
    ['resolved', 'resolved'],
  ] as const)(
    'applies resolution=%s to list and count queries in the active workspace',
    async (resolution, status) => {
      alertFindMany.mockResolvedValue([]);
      alertCount.mockResolvedValue(0);

      const { GET } = await import('@/app/api/alerts/route');
      const res = await GET(
        makeRequest(
          `http://test/api/alerts?resolution=${resolution}&q=legacy&severity=critical&sort=created_asc`,
        ),
      );
      expect(res.status).toBe(200);

      const listCall = alertFindMany.mock.calls.at(-1)?.[0] as
        | { where?: Record<string, unknown>; orderBy?: unknown }
        | undefined;
      const listWhere = listCall?.where ?? {};
      expect(listWhere.teamId).toBe('active-workspace-1');
      expect(listWhere.severity).toEqual({ in: ['critical'] });
      expect(listCall?.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
      if (status === undefined) {
        expect(listWhere.status).toBeUndefined();
      } else {
        expect(listWhere.status).toEqual(status);
      }
      expect(listWhere.finding).toBeDefined();

      const countWheres = alertCount.mock.calls
        .map((call) => call[0]?.where as Record<string, unknown>)
        .filter(Boolean);
      expect(countWheres).toEqual(
        expect.arrayContaining([expect.objectContaining({ teamId: 'active-workspace-1' })]),
      );
      for (const where of countWheres) {
        expect(where.teamId).toBe('active-workspace-1');
        if (status === undefined) expect(where.status).toBeUndefined();
        else expect(where.status).toEqual(status);
      }
    },
  );

  it('sorts oldest-first within the active workspace and preserves unresolved/status filters', async () => {
    alertFindMany
      .mockResolvedValueOnce([makeAlert()])
      .mockResolvedValueOnce([makeAlert({ id: 'resolved-alert', status: 'resolved' })]);
    alertCount.mockResolvedValue(1);

    const { GET } = await import('@/app/api/alerts/route');

    const unresolvedResponse = await GET(makeRequest('http://test/api/alerts?sort=created_asc'));
    expect(unresolvedResponse.status).toBe(200);
    expect(alertFindMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: 'active-workspace-1',
          status: { not: 'resolved' },
        }),
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );

    const resolvedResponse = await GET(
      makeRequest('http://test/api/alerts?sort=created_asc&status=resolved'),
    );
    expect(resolvedResponse.status).toBe(200);
    expect(alertFindMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: 'active-workspace-1',
          status: 'resolved',
        }),
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  it('returns stable creation-time pages after filters inside the active workspace', async () => {
    const tiedAt = new Date('2026-01-03T00:00:00Z');
    const rows = [
      makeAlert({
        id: 'tie-a',
        status: 'in_progress',
        severity: 'high',
        createdAt: tiedAt,
      }),
      makeAlert({
        id: 'oldest',
        status: 'in_progress',
        severity: 'high',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      }),
      makeAlert({
        id: 'newest',
        status: 'in_progress',
        severity: 'high',
        createdAt: new Date('2026-01-04T00:00:00Z'),
      }),
      makeAlert({
        id: 'tie-z',
        status: 'in_progress',
        severity: 'high',
        createdAt: tiedAt,
      }),
      makeAlert({
        id: 'wrong-severity',
        status: 'in_progress',
        severity: 'low',
        createdAt: new Date('2026-01-05T00:00:00Z'),
      }),
      makeAlert({
        id: 'foreign-workspace',
        teamId: 'another-workspace',
        status: 'in_progress',
        severity: 'high',
        createdAt: new Date('2026-01-06T00:00:00Z'),
      }),
    ];
    alertFindMany.mockImplementation(async (args) => {
      const where = args.where ?? {};
      const orderBy = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy ?? {}];
      const createdDirection = orderBy[0]?.createdAt === 'asc' ? 'asc' : 'desc';
      const idDirection = orderBy[1]?.id === 'asc' ? 'asc' : 'desc';
      const filtered = rows
        .filter((row) => row.teamId === where.teamId)
        .filter((row) => where.status === undefined || row.status === where.status)
        .filter(
          (row) =>
            !where.severity ||
            (Array.isArray(where.severity.in) && where.severity.in.includes(row.severity)),
        )
        .sort((a, b) => {
          const dateDiff = a.createdAt.getTime() - b.createdAt.getTime();
          if (dateDiff !== 0) return createdDirection === 'asc' ? dateDiff : -dateDiff;
          return idDirection === 'asc' ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id);
        });
      const skip = args.skip ?? 0;
      return filtered.slice(skip, skip + (args.take ?? filtered.length));
    });
    alertCount.mockResolvedValue(4);

    const { GET } = await import('@/app/api/alerts/route');
    const cases = [
      {
        sort: 'created',
        direction: 'desc',
        ids: ['newest', 'tie-z', 'tie-a', 'oldest'],
      },
      {
        sort: 'created_asc',
        direction: 'asc',
        ids: ['oldest', 'tie-a', 'tie-z', 'newest'],
      },
    ] as const;

    let callNumber = 0;
    for (const testCase of cases) {
      for (const page of [1, 2]) {
        callNumber += 1;
        const response = await GET(
          makeRequest(
            `http://test/api/alerts?sort=${testCase.sort}&page=${page}&pageSize=2&status=in_progress&severity=high`,
          ),
        );

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.items.map((item: { id: string }) => item.id)).toEqual(
          testCase.ids.slice((page - 1) * 2, page * 2),
        );
        expect(body.items.map((item: { teamId: string }) => item.teamId)).toEqual([
          'active-workspace-1',
          'active-workspace-1',
        ]);
        expect(alertFindMany).toHaveBeenNthCalledWith(
          callNumber,
          expect.objectContaining({
            where: expect.objectContaining({
              teamId: 'active-workspace-1',
              status: 'in_progress',
              severity: { in: ['high'] },
            }),
            orderBy: [
              { createdAt: testCase.direction },
              { id: testCase.direction },
            ],
            skip: (page - 1) * 2,
            take: 2,
          }),
        );
      }
    }
  });

  it('sorts severity in both directions after active filters while ignoring workspace tampering', async () => {
    const rows = [
      makeAlertWithHost('low-alert', 'low', 'low.example', '2026-01-03T00:00:00Z'),
      makeAlertWithHost('critical-zeta', 'critical', 'zeta.example', '2026-01-01T00:00:00Z'),
      makeAlertWithHost(
        'critical-alpha-z',
        'critical',
        'alpha.example',
        '2026-01-04T00:00:00Z',
      ),
      makeAlertWithHost(
        'critical-alpha-a',
        'critical',
        'alpha.example',
        '2026-01-02T00:00:00Z',
      ),
      makeAlertWithHost('medium-alert', 'medium', 'medium.example', '2026-01-02T00:00:00Z'),
      makeAlertWithHost('unknown-alert', null, 'unknown.example', '2026-01-04T00:00:00Z'),
    ];
    alertFindMany.mockResolvedValue(rows);
    alertCount.mockResolvedValue(6);
    alertGroupBy.mockResolvedValue([
      { severity: 'critical', _count: 3 },
      { severity: 'medium', _count: 1 },
      { severity: 'low', _count: 1 },
      { severity: null, _count: 1 },
    ]);
    buildAlertSearchWhereMock.mockResolvedValue({
      finding: { OR: [{ cveId: { contains: 'legacy', mode: 'insensitive' } }] },
    });

    const { GET } = await import('@/app/api/alerts/route');

    const descending = await GET(
      makeRequest('http://test/api/alerts?sort=severity&q=legacy&source=vulncheck'),
    );
    expect(descending.status).toBe(200);
    await expect(descending.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({ id: 'critical-alpha-a' }),
        expect.objectContaining({ id: 'critical-alpha-z' }),
        expect.objectContaining({ id: 'critical-zeta' }),
        expect.objectContaining({ id: 'medium-alert' }),
        expect.objectContaining({ id: 'low-alert' }),
        expect.objectContaining({ id: 'unknown-alert' }),
      ],
      total: 6,
      counts: { critical: 3, high: 0, medium: 1, low: 2 },
    });

    expect(alertFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: 'active-workspace-1',
          source: 'vulncheck',
          finding: { OR: [{ cveId: { contains: 'legacy', mode: 'insensitive' } }] },
        }),
      }),
    );
    expect(alertFindMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: 'active-workspace-1',
          source: 'vulncheck',
          finding: { OR: [{ cveId: { contains: 'legacy', mode: 'insensitive' } }] },
        }),
        select: {
          id: true,
          severity: true,
          createdAt: true,
          finding: { select: { asset: { select: { host: true } } } },
        },
      }),
    );

    const ascending = await GET(
      makeRequest(
        'http://test/api/alerts?sort=severity_asc&q=legacy&source=vulncheck',
      ),
    );
    expect(ascending.status).toBe(200);
    await expect(ascending.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({ id: 'low-alert' }),
        expect.objectContaining({ id: 'medium-alert' }),
        expect.objectContaining({ id: 'critical-alpha-a' }),
        expect.objectContaining({ id: 'critical-alpha-z' }),
        expect.objectContaining({ id: 'critical-zeta' }),
        expect.objectContaining({ id: 'unknown-alert' }),
      ],
      total: 6,
      counts: { critical: 3, high: 0, medium: 1, low: 2 },
    });

    expect(alertFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ teamId: 'active-workspace-1' }),
      }),
    );

    for (const [args] of alertFindMany.mock.calls) {
      expect(args.where).toEqual(expect.objectContaining({ teamId: 'active-workspace-1' }));
    }
    for (const [args] of alertCount.mock.calls) {
      expect(args.where).toEqual(expect.objectContaining({ teamId: 'active-workspace-1' }));
    }
    for (const [args] of alertGroupBy.mock.calls) {
      expect(args.where).toEqual(expect.objectContaining({ teamId: 'active-workspace-1' }));
    }
  });

  it('applies severity order to the filtered result set before slicing the requested page', async () => {
    const globallyFilteredRows = [
      makeAlert({
        id: 'low-new',
        severity: 'low',
        status: 'in_progress',
        createdAt: new Date('2026-01-05T00:00:00Z'),
      }),
      makeAlert({
        id: 'medium',
        severity: 'medium',
        status: 'in_progress',
        createdAt: new Date('2026-01-04T00:00:00Z'),
      }),
      makeAlert({
        id: 'high',
        severity: 'high',
        status: 'in_progress',
        createdAt: new Date('2026-01-03T00:00:00Z'),
      }),
      makeAlert({
        id: 'critical',
        severity: 'critical',
        status: 'in_progress',
        createdAt: new Date('2026-01-02T00:00:00Z'),
      }),
      makeAlert({
        id: 'low-old',
        severity: 'low',
        status: 'in_progress',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      }),
    ];
    const rowsById = new Map(globallyFilteredRows.map((row) => [row.id, row]));
    alertFindMany.mockImplementation(async (args) => {
      if (args.select) {
        return globallyFilteredRows.map(({ id, severity, createdAt }) => ({
          id,
          severity,
          createdAt,
        }));
      }
      const selectedIds = args.where?.id?.in;
      if (selectedIds) return selectedIds.map((id: string) => rowsById.get(id));
      // Before the fix, SQL paginates by createdAt and returns this page;
      // its in-memory severity sort cannot recover the global page 2 slice.
      return [rowsById.get('high'), rowsById.get('critical')];
    });
    alertCount.mockResolvedValue(5);

    const { GET } = await import('@/app/api/alerts/route');
    const response = await GET(
      makeRequest('http://test/api/alerts?sort=severity&page=2&pageSize=2&status=in_progress'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 5,
      page: 2,
      pageSize: 2,
      items: [
        expect.objectContaining({ id: 'medium' }),
        expect.objectContaining({ id: 'low-new' }),
      ],
    });
    expect(alertFindMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ teamId: 'active-workspace-1', status: 'in_progress' }),
        select: {
          id: true,
          severity: true,
          createdAt: true,
          finding: { select: { asset: { select: { host: true } } } },
        },
      }),
    );
    expect(alertFindMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: 'active-workspace-1',
          status: 'in_progress',
          id: { in: ['medium', 'low-new'] },
        }),
      }),
    );
    expect(alertFindMany.mock.calls[0]?.[0]).not.toHaveProperty('skip');
    expect(alertFindMany.mock.calls[0]?.[0]).not.toHaveProperty('take');
    expect(alertFindMany.mock.calls[1]?.[0]).not.toHaveProperty('skip');
    expect(alertFindMany.mock.calls[1]?.[0]).not.toHaveProperty('take');

    const ascendingResponse = await GET(
      makeRequest('http://test/api/alerts?sort=severity_asc&page=2&pageSize=2&status=in_progress'),
    );
    expect(ascendingResponse.status).toBe(200);
    await expect(ascendingResponse.json()).resolves.toMatchObject({
      total: 5,
      page: 2,
      pageSize: 2,
      items: [expect.objectContaining({ id: 'medium' }), expect.objectContaining({ id: 'high' })],
    });
    expect(alertFindMany).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        select: {
          id: true,
          severity: true,
          createdAt: true,
          finding: { select: { asset: { select: { host: true } } } },
        },
      }),
    );
    expect(alertFindMany).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['medium', 'high'] } }),
      }),
    );
    expect(alertFindMany.mock.calls[2]?.[0]).not.toHaveProperty('skip');
    expect(alertFindMany.mock.calls[2]?.[0]).not.toHaveProperty('take');
    expect(alertFindMany.mock.calls[3]?.[0]).not.toHaveProperty('skip');
    expect(alertFindMany.mock.calls[3]?.[0]).not.toHaveProperty('take');
  });

  it('uses hostname and alert ID ties before slicing pages in both severity directions', async () => {
    const rows = [
      makeAlertWithHost('critical-zeta', 'critical', 'zeta.example', '2026-01-01T00:00:00Z'),
      makeAlertWithHost('critical-alpha-z', 'critical', 'alpha.example', '2026-01-03T00:00:00Z'),
      makeAlertWithHost('critical-alpha-a', 'critical', 'alpha.example', '2026-01-02T00:00:00Z'),
      makeAlertWithHost('high', 'high', 'high.example', '2026-01-04T00:00:00Z'),
      makeAlertWithHost('medium', 'medium', 'medium.example', '2026-01-05T00:00:00Z'),
      makeAlertWithHost('low', 'low', 'low.example', '2026-01-06T00:00:00Z'),
    ];
    const hostById = new Map([
      ['critical-zeta', 'zeta.example'],
      ['critical-alpha-z', 'alpha.example'],
      ['critical-alpha-a', 'alpha.example'],
      ['high', 'high.example'],
      ['medium', 'medium.example'],
      ['low', 'low.example'],
    ]);
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    alertFindMany.mockImplementation(async (args) => {
      if (args.select) {
        return rows.map(({ id, severity, createdAt }) => ({
          id,
          severity,
          createdAt,
          finding: { asset: { host: hostById.get(id) } },
        }));
      }
      const selectedIds = args.where?.id?.in;
      if (selectedIds) return selectedIds.map((id: string) => rowsById.get(id));
      return [];
    });
    alertCount.mockResolvedValue(6);

    const { GET } = await import('@/app/api/alerts/route');
    const descending = await GET(
      makeRequest('http://test/api/alerts?sort=severity&page=2&pageSize=2'),
    );
    expect(descending.status).toBe(200);
    await expect(descending.json()).resolves.toMatchObject({
      total: 6,
      page: 2,
      pageSize: 2,
      items: [
        expect.objectContaining({ id: 'critical-zeta' }),
        expect.objectContaining({ id: 'high' }),
      ],
    });

    const ascending = await GET(
      makeRequest('http://test/api/alerts?sort=severity_asc&page=3&pageSize=2'),
    );
    expect(ascending.status).toBe(200);
    await expect(ascending.json()).resolves.toMatchObject({
      total: 6,
      page: 3,
      pageSize: 2,
      items: [
        expect.objectContaining({ id: 'critical-alpha-z' }),
        expect.objectContaining({ id: 'critical-zeta' }),
      ],
    });

    expect(alertFindMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ teamId: 'active-workspace-1' }),
        select: {
          id: true,
          severity: true,
          createdAt: true,
          finding: { select: { asset: { select: { host: true } } } },
        },
      }),
    );
    expect(alertFindMany).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        where: expect.objectContaining({ teamId: 'active-workspace-1' }),
        select: {
          id: true,
          severity: true,
          createdAt: true,
          finding: { select: { asset: { select: { host: true } } } },
        },
      }),
    );
  });

  it('orders risk scores in both directions, keeps nulls last, and preserves active filters', async () => {
    alertFindMany.mockResolvedValue([]);
    alertCount.mockResolvedValue(0);
    buildAlertSearchWhereMock.mockResolvedValue({
      finding: { OR: [{ cveId: { contains: 'legacy', mode: 'insensitive' } }] },
    });

    for (const [sort, direction] of [
      ['riskScore', 'desc'],
      ['riskScore:asc', 'asc'],
    ] as const) {
      const { GET } = await import('@/app/api/alerts/route');
      const res = await GET(
        makeRequest(
          `http://test/api/alerts?sort=${encodeURIComponent(sort)}&severity=critical&q=legacy&source=vulncheck&acknowledged=false`,
        ),
      );
      expect(res.status).toBe(200);
      expect(alertFindMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            teamId: 'active-workspace-1',
            severity: { in: ['critical'] },
            source: 'vulncheck',
            acknowledgedAt: null,
            finding: expect.objectContaining({
              OR: [{ cveId: { contains: 'legacy', mode: 'insensitive' } }],
            }),
          }),
          orderBy: [
            {
              finding: {
                priorityScore: { sort: direction, nulls: 'last' },
              },
            },
            { createdAt: 'desc' },
            { id: 'desc' },
          ],
        }),
      );
    }
  });

  it('passes severity, source, acknowledged filters through to prisma', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(
      makeRequest('http://test/api/alerts?severity=critical&source=vulncheck&acknowledged=false'),
    );
    expect(res.status).toBe(200);
    expect(alertFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: 'active-workspace-1',
          severity: { in: ['critical'] },
          source: 'vulncheck',
          acknowledgedAt: null,
        }),
      }),
    );
  });

  it('passes comma-separated severities through to prisma as severity: { in: [...] }', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?severity=critical,high'));
    expect(res.status).toBe(200);
    expect(alertFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: 'active-workspace-1',
          severity: { in: ['critical', 'high'] },
        }),
      }),
    );
  });

  it('returns distinct authorized severity options in canonical order, excluding null and blank values', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    // The first groupBy is the current-view count aggregation. The second
    // intentionally omits the active severity so all filter choices remain
    // discoverable.
    alertGroupBy
      .mockResolvedValueOnce([
        { severity: 'critical', _count: 2 },
        { severity: 'unknown', _count: 3 },
        { severity: null, _count: 1 },
      ])
      .mockResolvedValueOnce([
        { severity: 'zeta', _count: 1 },
        { severity: 'High', _count: 2 },
        { severity: 'critical', _count: 3 },
        { severity: ' legacy-value ', _count: 4 },
        { severity: '   ', _count: 5 },
        { severity: null, _count: 6 },
      ]);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?severity=legacy-value'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      counts: { critical: 2, high: 0, medium: 0, low: 4 },
      severityOptions: ['critical', 'High', 'legacy-value', 'zeta'],
    });
    expect(alertGroupBy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: 'active-workspace-1',
          severity: { in: ['legacy-value'] },
        }),
      }),
    );
    expect(alertGroupBy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ teamId: 'active-workspace-1' }),
      }),
    );
    expect(alertGroupBy.mock.calls[1]?.[0]?.where).not.toHaveProperty('severity');
  });

  it('keeps severity options workspace-wide when status and hostname narrow the alert rows', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    alertGroupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { severity: 'critical', _count: 1 },
      { severity: 'high', _count: 2 },
      { severity: 'medium', _count: 3 },
      { severity: 'low', _count: 4 },
    ]);
    buildAlertSearchWhereMock.mockResolvedValueOnce({
      finding: { asset: { host: { contains: 'api.example', mode: 'insensitive' } } },
    });

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(
      makeRequest(
        'http://test/api/alerts?severity=high&status=in_progress&hostname=api.example',
      ),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      total: 0,
      severityOptions: ['critical', 'high', 'medium', 'low'],
    });
    expect(alertFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: 'active-workspace-1',
          severity: { in: ['high'] },
          status: 'in_progress',
          finding: { asset: { host: { contains: 'api.example', mode: 'insensitive' } } },
        }),
      }),
    );
    expect(alertGroupBy).toHaveBeenNthCalledWith(2, {
      by: ['severity'],
      where: { teamId: 'active-workspace-1' },
      _count: true,
    });
  });

  it('composes arbitrary severity with search and source inside the active workspace scope', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    buildAlertSearchWhereMock.mockResolvedValueOnce({
      finding: { OR: [{ cveId: { contains: 'legacy', mode: 'insensitive' } }] },
    });

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(
      makeRequest('http://test/api/alerts?severity=legacy-value&q=legacy&source=vulncheck'),
    );
    expect(res.status).toBe(200);
    expect(alertFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: 'active-workspace-1',
          severity: { in: ['legacy-value'] },
          source: 'vulncheck',
          finding: expect.objectContaining({
            OR: [{ cveId: { contains: 'legacy', mode: 'insensitive' } }],
          }),
        }),
      }),
    );
    expect(alertGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: 'active-workspace-1',
          source: 'vulncheck',
          finding: expect.objectContaining({
            OR: [{ cveId: { contains: 'legacy', mode: 'insensitive' } }],
          }),
        }),
      }),
    );
  });

  it('drops the severity clause when severity is empty', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?severity='));
    expect(res.status).toBe(200);
    const whereArg = alertFindMany.mock.calls[0]?.[0]?.where;
    expect(whereArg).not.toHaveProperty('severity');
  });

  it('passes acknowledged=true -> acknowledgedAt: { not: null }', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?acknowledged=true'));
    expect(res.status).toBe(200);
    expect(alertFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: 'active-workspace-1',
          acknowledgedAt: { not: null },
        }),
      }),
    );
  });

  it('assigneeReady=true expands to acknowledgedAt:null + assigneeId:null', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?assigneeReady=true'));
    expect(res.status).toBe(200);
    expect(alertFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: 'active-workspace-1',
          acknowledgedAt: null,
          assigneeId: null,
        }),
      }),
    );
  });

  it('returns 403 when the user is below member', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Forbidden' }, { status: 403 });
    });
    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts'));
    expect(res.status).toBe(403);
    expect(resolveDashboardWorkspaceContextMock).not.toHaveBeenCalled();
  });

  it('returns 401 when there is no session', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Unauthorized' }, { status: 401 });
    });
    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts'));
    expect(res.status).toBe(401);
    expect(resolveDashboardWorkspaceContextMock).not.toHaveBeenCalled();
  });

  it('returns the JSON no-active-workspace response without querying alerts', async () => {
    resolveDashboardWorkspaceContextMock.mockResolvedValueOnce(null);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts'));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'No active workspace' });
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertCount).not.toHaveBeenCalled();
    expect(alertGroupBy).not.toHaveBeenCalled();
    expect(vulnerabilityTrendFindFirst).not.toHaveBeenCalled();
  });

  it('composes resolved status, severity, and owner inside the validated active workspace', async () => {
    alertFindMany.mockResolvedValueOnce([
      makeAlert({ status: 'resolved', ownerId: 'active-workspace-member-1' }),
    ]);
    alertCount.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    workspaceMemberFindMany.mockResolvedValueOnce([
      { id: 'active-workspace-member-1', userId: 'user-2' },
    ]);
    userFindMany.mockResolvedValueOnce([{ id: 'user-2', name: 'Workspace member' }]);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(
      makeRequest(
        'http://test/api/alerts?status=resolved&severity=high&ownedByMe=1',
      ),
    );

    expect(res.status).toBe(200);
    const expectedScope = {
      teamId: 'active-workspace-1',
      status: 'resolved',
      ownerId: { in: ['active-workspace-member-1'] },
    };
    const expectedFilter = {
      ...expectedScope,
      severity: { in: ['high'] },
    };
    expect(alertFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining(expectedFilter) }),
    );
    expect(workspaceMemberFindMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['active-workspace-member-1'] },
        workspaceId: 'active-workspace-1',
        status: 'active',
      },
      select: { id: true, userId: true },
    });
    expect(alertCount).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: expect.objectContaining(expectedFilter) }),
    );
    expect(alertCount).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          ...expectedScope,
          snoozedUntil: { gt: expect.any(Date) },
        }),
      }),
    );
    expect(alertGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining(expectedScope) }),
    );
  });

  it('rejects an unknown status without querying alerts', async () => {
    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?status=unknown'));

    expect(res.status).toBe(400);
    expect(alertFindMany).not.toHaveBeenCalled();
    expect(alertCount).not.toHaveBeenCalled();
    expect(alertGroupBy).not.toHaveBeenCalled();
  });

  it('composes active workspace, severity, open status, and the active roster owner across list reads', async () => {
    alertFindMany.mockResolvedValueOnce([makeAlert({ ownerId: 'active-workspace-member-1' })]);
    alertCount.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    workspaceMemberFindMany.mockResolvedValueOnce([
      { id: 'active-workspace-member-1', userId: 'user-2' },
    ]);
    userFindMany.mockResolvedValueOnce([{ id: 'user-2', name: 'Workspace member' }]);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(
      makeRequest(
        'http://test/api/alerts?severity=critical&status=open&ownedByMe=1',
      ),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0].ownerName).toBe('Workspace member');

    const expectedScope = {
      teamId: 'active-workspace-1',
      status: 'open',
      ownerId: { in: ['active-workspace-member-1'] },
    };
    expect(alertFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ...expectedScope,
          severity: { in: ['critical'] },
        }),
      }),
    );
    expect(alertCount).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: expect.objectContaining(expectedScope) }),
    );
    expect(alertGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining(expectedScope) }),
    );
    expect(alertCount).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          ...expectedScope,
          snoozedUntil: { gt: expect.any(Date) },
        }),
      }),
    );
    expect(vulnerabilityTrendFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: 'active-workspace-1' } }),
    );
    expect(workspaceMemberFindMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['active-workspace-member-1'] },
        workspaceId: 'active-workspace-1',
        status: 'active',
      },
      select: { id: true, userId: true },
    });
    expect(computeAlertLastActivityAtForListMock).toHaveBeenCalledWith(
      expect.any(Array),
      'active-workspace-1',
    );
  });

  it('matches no alerts for ownedByMe when the active workspace has no roster row', async () => {
    resolveDashboardWorkspaceContextMock.mockResolvedValueOnce({
      workspaceId: 'active-workspace-1',
      workspaceMemberId: null,
    });
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?ownedByMe=1'));

    expect(res.status).toBe(200);
    expect(alertFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ ownerId: { in: [] } }) }),
    );
  });

  it('returns 400 on invalid query params (pageSize over max)', async () => {
    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?pageSize=999'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('bad_request');
  });

  it('returns 400 on invalid source value', async () => {
    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?source=osm'));
    expect(res.status).toBe(400);
  });

  it('returns 500 on DB error', async () => {
    alertFindMany.mockRejectedValueOnce(new Error('db down'));
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts'));
    expect(res.status).toBe(500);
  });

  // ===================== ?asset= composite-name multi-select =====================

  describe('GET /api/alerts — ?asset=<csv> (composite host:port/protocol multi-select)', () => {
    // Brief: clicking the asset chip row narrows the list to findings
    // whose joined `VulnerabilityFinding → Asset` matches one of the
    // comma-separated entries. Wire shape on /api/alerts is the
    // `finding: { asset: { OR: [{ host, port, protocol }, …] } }`
    // composite-IN shape — three columns can't be a single `name: { in
    // }`, so the route fans each CSV entry into a triplet arm.

    it('appends a single composite asset into the finding.asset.OR list', async () => {
      alertFindMany.mockResolvedValueOnce([]);
      alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

      const { GET } = await import('@/app/api/alerts/route');
      const res = await GET(makeRequest('http://test/api/alerts?asset=example.com:443/tcp'));
      expect(res.status).toBe(200);
      expect(alertFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            teamId: 'active-workspace-1',
            finding: expect.objectContaining({
              asset: {
                OR: [{ host: 'example.com', port: 443, protocol: 'tcp' }],
              },
            }),
          }),
        }),
      );
    });

    it('appends multiple composite assets, preserving canonical alphabetical order', async () => {
      alertFindMany.mockResolvedValueOnce([]);
      alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

      const { GET } = await import('@/app/api/alerts/route');
      const res = await GET(
        makeRequest('http://test/api/alerts?asset=example.com:443/tcp,vpn.example.com:80/tcp'),
      );
      expect(res.status).toBe(200);
      expect(alertFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            finding: expect.objectContaining({
              asset: {
                OR: [
                  { host: 'example.com', port: 443, protocol: 'tcp' },
                  { host: 'vpn.example.com', port: 80, protocol: 'tcp' },
                ],
              },
            }),
          }),
        }),
      );
    });

    it('drops the asset clause when ?asset= is empty / absent', async () => {
      alertFindMany.mockResolvedValueOnce([]);
      alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

      const { GET } = await import('@/app/api/alerts/route');
      const res = await GET(makeRequest('http://test/api/alerts'));
      expect(res.status).toBe(200);
      const whereArg = alertFindMany.mock.calls[0]?.[0]?.where as {
        finding?: unknown;
      };
      expect(whereArg).not.toHaveProperty('finding.asset');
    });

    it('returns 400 when a single entry fails the composite shape (malformed_name)', async () => {
      const { GET } = await import('@/app/api/alerts/route');
      const res = await GET(makeRequest('http://test/api/alerts?asset=not-a-name'));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('bad_request');
      expect(body.message).toContain('not-a-name');
    });

    it('composes asset with severity in a single nested finding literal (no shallow-spread overwrite)', async () => {
      alertFindMany.mockResolvedValueOnce([]);
      alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

      const { GET } = await import('@/app/api/alerts/route');
      const res = await GET(
        makeRequest('http://test/api/alerts?severity=critical&asset=example.com:443/tcp'),
      );
      expect(res.status).toBe(200);
      expect(alertFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            teamId: 'active-workspace-1',
            severity: { in: ['critical'] },
            finding: expect.objectContaining({
              asset: {
                OR: [{ host: 'example.com', port: 443, protocol: 'tcp' }],
              },
            }),
          }),
        }),
      );
    });
  });

  it.each([['PUT'], ['PATCH'], ['DELETE']])(
    '%s returns 405 with Allow: GET, POST',
    async (method) => {
      const routeModule = await import('@/app/api/alerts/route');
      const handler = (routeModule as unknown as Record<string, () => Promise<Response>>)[method];
      const res = await handler(makeRequest('http://test/api/alerts'));
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('GET, POST');
    },
  );
});

// ===================== hideSnoozed gate (literal '1') =====================

describe('GET /api/alerts — ?hideSnoozed=1 (inverted toggle)', () => {
  // Brief: hideSnoozed's wire shape is the literal `'1'` (NOT `'true'`).
  // Default = snoozed rows visible (no OR arm); `?hideSnoozed=1` slices
  // in the two OR siblings `(snoozedUntil IS NULL OR snoozedUntil <= now)`.

  it('no hideSnoozed param → OR arm is NOT present in the where (snoozed rows visible by default)', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts'));
    expect(res.status).toBe(200);

    const findManyCall = alertFindMany.mock.calls[0]?.[0] as {
      where: { OR?: Array<Record<string, unknown>> } | undefined;
    };
    const orArms = findManyCall?.where?.OR ?? [];
    const hasSnoozedArm = orArms.some(
      (a) =>
        (a as { snoozedUntil?: unknown }).snoozedUntil === null ||
        typeof (a as { snoozedUntil?: { lte?: Date } }).snoozedUntil?.lte === 'object',
    );
    expect(hasSnoozedArm).toBe(false);
  });

  it('?hideSnoozed=1 splices the snooze OR arm into the top-level where.OR', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?hideSnoozed=1'));
    expect(res.status).toBe(200);

    const findManyCall = alertFindMany.mock.calls[0]?.[0] as {
      where: { OR?: Array<Record<string, unknown>> } | undefined;
    };
    const orArms = findManyCall?.where?.OR ?? [];
    const nullArm = orArms.find((a) => (a as { snoozedUntil?: unknown }).snoozedUntil === null);
    const lteArm = orArms.find(
      (a) =>
        typeof (a as { snoozedUntil?: { lte?: Date } }).snoozedUntil?.lte === 'object' &&
        (a as { snoozedUntil?: { lte?: Date } }).snoozedUntil?.lte instanceof Date,
    );
    expect(nullArm).toBeDefined();
    expect(lteArm).toBeDefined();
  });

  it('?hideSnoozed=true (legacy string) is a literal-fit failure — AlertQuery.safeParse returns 400', async () => {
    // The wire shape is the literal `'1'` only — `z.literal('1').optional()`
    // rejects any other string with a parse failure. The route surfaces that
    // failure as a 400 (NOT a silent strip to the absent default). The
    // literal-only contract is what keeps the URL round-trip unambiguous —
    // a future widen-the-literal-to-also-accept-true would silently turn
    // legacy URLs into a hide-snoozed branch that the brief explicitly
    // disallows.
    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?hideSnoozed=true'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('bad_request');
  });

  it('?hideSnoozed=0 (literal 0, NOT 1) is also a literal-fit failure — 400', async () => {
    // Mirror of the above case: any non-`'1'` string is rejected. This
    // catches a future drift where someone widens the literal to a
    // Boolish — a regression the brief explicitly forbids.
    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?hideSnoozed=0'));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/alerts — workflow status filter', () => {
  it.each(['open', 'in_progress', 'resolved', 'false_positive', 'snoozed'] as const)(
    'filters status=%s, totals, and active workspace while composing the other filters',
    async (status) => {
      alertFindMany.mockResolvedValueOnce([]);
      alertCount.mockResolvedValueOnce(7).mockResolvedValueOnce(2);

      const { GET } = await import('@/app/api/alerts/route');
      const res = await GET(
        makeRequest(
          `http://test/api/alerts?status=${status}&resolution=all&severity=high&source=manual&triggeredBy=scheduled&hideSnoozed=1&since=7d`,
        ),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ total: 7 });

      const expectedWhere: Record<string, unknown> = {
        teamId: 'active-workspace-1',
        source: 'manual',
        severity: { in: ['high'] },
        finding: { scan: { source: 'scheduled' } },
      };
      if (status === 'snoozed') {
        expectedWhere.snoozedUntil = { gt: expect.any(Date) };
      } else {
        expectedWhere.status = status;
      }
      if (status === 'open') {
        expectedWhere.OR = [
          { snoozedUntil: null },
          { snoozedUntil: { lte: expect.any(Date) } },
        ];
      }

      expect(alertFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining(expectedWhere) }),
      );
      expect(alertCount).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ where: expect.objectContaining(expectedWhere) }),
      );
      if (status === 'open') {
        const where = alertFindMany.mock.calls[0]?.[0]?.where as {
          AND?: Array<{ OR?: Array<Record<string, unknown>> }>;
        };
        expect(where.AND).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              OR: expect.arrayContaining([
                expect.objectContaining({ createdAt: { gte: expect.any(Date) } }),
              ]),
            }),
          ]),
        );
      }
      expect(expectedWhere.teamId).toBe('active-workspace-1');
    },
  );
});
