// @vitest-environment node
// Active-workspace and hostname-filter coverage for GET /api/assets.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  alertFindMany,
  assetFindMany,
  computeAlertLastActivityAtForList,
  loadAssetRiskChanges,
  matchesAssetRiskTrend,
  requireTeamRole,
  resolveDashboardWorkspaceContext,
} = vi.hoisted(() => ({
  alertFindMany: vi.fn(),
  assetFindMany: vi.fn(),
  computeAlertLastActivityAtForList: vi.fn(),
  loadAssetRiskChanges: vi.fn(),
  matchesAssetRiskTrend: vi.fn(
    (change: number | null, trend: 'rising' | 'falling' | 'unchanged' | undefined) => {
      if (trend === undefined) return true;
      if (change === null) return false;
      if (trend === 'rising') return change > 0;
      if (trend === 'falling') return change < 0;
      return change === 0;
    },
  ),
  requireTeamRole: vi.fn(),
  resolveDashboardWorkspaceContext: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({
  prisma: {
    alert: { findMany: alertFindMany },
    asset: { findMany: assetFindMany },
  },
}));
vi.mock('@/lib/business/alerts-activity', () => ({
  computeAlertLastActivityAtForList,
}));
vi.mock('@/lib/business/assets-risk-trend', () => ({
  loadAssetRiskChanges,
  matchesAssetRiskTrend,
}));
vi.mock('@/lib/team-auth', () => ({ requireTeamRole }));
vi.mock('@/lib/business/dashboard-workspace-context', () => ({
  resolveDashboardWorkspaceContext,
}));
vi.mock('@/lib/logging/with-request', () => ({
  setRequestAuth: vi.fn(),
  withApiRequest: (_request: Request, handler: () => Promise<Response>) => handler(),
}));

const context = {
  user: { id: 'user-1' },
  membership: { id: 'default-member', teamId: 'default-team' },
};

function makeAlert(
  host = 'web.example.invalid',
  priorityScore: number | null = null,
  id = `alert-${host}-${priorityScore ?? 'null'}`,
  status = 'open',
  severity = 'high',
  teamId = 'active-workspace',
) {
  return {
    id,
    teamId,
    severity,
    status,
    remediatedAt: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    finding: { priorityScore, asset: { host, port: 443, serviceHint: 'https' } },
  };
}

function makeRequest(path: string) {
  return new Request(`http://localhost${path}`);
}

function makeScanAsset(
  host: string,
  startedAt: string,
  status = 'completed',
  id = `scan-${host}-${startedAt}`,
  teamId = 'active-workspace',
) {
  return { host, scan: { id, teamId, startedAt: new Date(startedAt), status } };
}

beforeEach(() => {
  vi.resetModules();
  alertFindMany.mockReset();
  assetFindMany.mockReset();
  computeAlertLastActivityAtForList.mockReset();
  loadAssetRiskChanges.mockReset();
  requireTeamRole.mockReset();
  resolveDashboardWorkspaceContext.mockReset();

  requireTeamRole.mockResolvedValue(context);
  resolveDashboardWorkspaceContext.mockResolvedValue({
    workspaceId: 'active-workspace',
    workspaceMemberId: 'active-member',
  });
  computeAlertLastActivityAtForList.mockResolvedValue(new Map());
  loadAssetRiskChanges.mockResolvedValue(new Map());
  alertFindMany.mockResolvedValue([makeAlert()]);
  assetFindMany.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/assets', () => {
  it('counts open and in-progress alerts independently of inventory status filters', async () => {
    alertFindMany
      .mockResolvedValueOnce([
        makeAlert('empty.example.invalid', null, 'resolved-empty', 'resolved', 'critical'),
        makeAlert('shared.example.invalid', null, 'resolved-shared', 'resolved', 'critical'),
      ])
      .mockResolvedValueOnce([
        makeAlert('shared.example.invalid', null, 'open-shared', 'open'),
        makeAlert('shared.example.invalid', null, 'progress-shared', 'in_progress'),
      ]);
    const { GET } = await import('@/app/api/assets/route');

    const response = await GET(makeRequest('/api/assets?status=resolved&severity=critical'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toEqual([
      expect.objectContaining({
        name: 'empty.example.invalid',
        unresolvedCount: 0,
        highestUnresolvedSeverity: null,
      }),
      expect.objectContaining({
        name: 'shared.example.invalid',
        unresolvedCount: 2,
        criticalCount: 1,
        highestUnresolvedSeverity: 'high',
      }),
    ]);
    expect(alertFindMany).toHaveBeenCalledTimes(2);
    expect(alertFindMany.mock.calls[1]?.[0]).toEqual({
      where: {
        teamId: 'active-workspace',
        status: { in: ['open', 'in_progress'] },
        findingId: { not: 'manual' },
        finding: { asset: { scan: { teamId: 'active-workspace' } } },
      },
      select: {
        teamId: true,
        status: true,
        severity: true,
        finding: { select: { asset: { select: { host: true } } } },
      },
    });
  });

  it('filters unresolved hosts before pagination and scopes same-host counts to the active workspace', async () => {
    const fixtures = [
      {
        workspaceId: 'active-workspace',
        alert: makeAlert('alpha.example.invalid', null, 'alpha-open', 'open'),
      },
      {
        workspaceId: 'active-workspace',
        alert: makeAlert('bravo.example.invalid', null, 'bravo-snoozed', 'snoozed'),
      },
      {
        workspaceId: 'active-workspace',
        alert: makeAlert('charlie.example.invalid', null, 'charlie-progress', 'in_progress'),
      },
      {
        workspaceId: 'active-workspace',
        alert: makeAlert('delta.example.invalid', null, 'delta-false-positive', 'false_positive'),
      },
      {
        workspaceId: 'active-workspace',
        alert: makeAlert('echo.example.invalid', null, 'echo-resolved', 'resolved'),
      },
      {
        workspaceId: 'foreign-workspace',
        alert: makeAlert('charlie.example.invalid', null, 'foreign-charlie-open', 'open'),
      },
      {
        workspaceId: 'foreign-workspace',
        alert: makeAlert('foreign-only.example.invalid', null, 'foreign-only-open', 'open'),
      },
    ];
    const activeFixtures = fixtures.filter((fixture) => fixture.workspaceId === 'active-workspace');
    const activeUnresolvedFixtures = activeFixtures.filter(
      ({ alert }) => alert.status === 'open' || alert.status === 'in_progress',
    );
    alertFindMany
      .mockResolvedValueOnce(activeFixtures.map(({ alert }) => alert))
      .mockResolvedValueOnce(activeUnresolvedFixtures.map(({ alert }) => alert));
    const { GET } = await import('@/app/api/assets/route');

    const response = await GET(
      makeRequest(
        '/api/assets?alertPresence=with&sort=name&page=2&pageSize=1&workspaceId=foreign-workspace',
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [
        expect.objectContaining({
          name: 'charlie.example.invalid',
          unresolvedCount: 1,
          highestUnresolvedSeverity: 'high',
        }),
      ],
      total: 2,
    });
    expect(alertFindMany).toHaveBeenCalledTimes(2);
    expect(alertFindMany.mock.calls[0]?.[0]?.where).toEqual({
      teamId: 'active-workspace',
      findingId: { not: 'manual' },
      finding: { asset: { scan: { teamId: 'active-workspace' } } },
    });
    expect(alertFindMany.mock.calls[1]?.[0]?.where).toEqual({
      teamId: 'active-workspace',
      status: { in: ['open', 'in_progress'] },
      findingId: { not: 'manual' },
      finding: { asset: { scan: { teamId: 'active-workspace' } } },
    });
  });

  it('keeps filtered page counts scoped to the active workspace despite a requested workspace id', async () => {
    alertFindMany
      .mockResolvedValueOnce([
        makeAlert('alpha.example.invalid', null, 'alpha-filtered', 'resolved'),
        makeAlert('beta.example.invalid', null, 'beta-filtered', 'resolved'),
        makeAlert('gamma.example.invalid', null, 'gamma-filtered', 'resolved'),
      ])
      .mockResolvedValueOnce([
        { ...makeAlert('alpha.example.invalid', null, 'alpha-open', 'open'), severity: 'low' },
        {
          ...makeAlert('alpha.example.invalid', null, 'alpha-progress', 'in_progress'),
          severity: 'critical',
        },
        { ...makeAlert('beta.example.invalid', null, 'beta-open', 'open'), severity: 'low' },
      ]);
    const { GET } = await import('@/app/api/assets/route');

    const response = await GET(
      makeRequest(
        '/api/assets?workspaceId=requested-workspace&severity=high&status=resolved&sort=name&page=2&pageSize=1',
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [expect.objectContaining({ name: 'beta.example.invalid', unresolvedCount: 1 })],
      total: 3,
    });
    expect(alertFindMany.mock.calls[0]?.[0]?.where).toEqual({
      teamId: 'active-workspace',
      status: 'resolved',
      severity: 'high',
      findingId: { not: 'manual' },
      finding: { asset: { scan: { teamId: 'active-workspace' } } },
    });
    expect(alertFindMany.mock.calls[1]?.[0]).toEqual({
      where: {
        teamId: 'active-workspace',
        status: { in: ['open', 'in_progress'] },
        findingId: { not: 'manual' },
        finding: { asset: { scan: { teamId: 'active-workspace' } } },
      },
      select: {
        teamId: true,
        status: true,
        severity: true,
        finding: { select: { asset: { select: { host: true } } } },
      },
    });
  });

  it('sorts unresolved totals using only the active workspace when another workspace is requested', async () => {
    const fixtures = [
      {
        workspaceId: 'active-workspace',
        alert: makeAlert('shared.example.invalid', null, 'shared-active-inventory', 'resolved'),
      },
      {
        workspaceId: 'active-workspace',
        alert: makeAlert('zeta.example.invalid', null, 'zeta-active-inventory', 'resolved'),
      },
      {
        workspaceId: 'active-workspace',
        alert: makeAlert('shared.example.invalid', null, 'shared-active-open', 'open'),
      },
      {
        workspaceId: 'active-workspace',
        alert: makeAlert('zeta.example.invalid', null, 'zeta-active-open-1', 'open'),
      },
      {
        workspaceId: 'active-workspace',
        alert: makeAlert('zeta.example.invalid', null, 'zeta-active-open-2', 'in_progress'),
      },
      ...Array.from({ length: 4 }, (_, index) => ({
        workspaceId: 'foreign-workspace',
        alert: makeAlert(
          'shared.example.invalid',
          null,
          `shared-foreign-open-${index + 1}`,
          'open',
        ),
      })),
      {
        workspaceId: 'foreign-workspace',
        alert: makeAlert('foreign-only.example.invalid', null, 'foreign-only-open', 'open'),
      },
    ];
    const activeFixtures = fixtures.filter((fixture) => fixture.workspaceId === 'active-workspace');
    const activeUnresolvedFixtures = activeFixtures.filter(
      ({ alert }) => alert.status === 'open' || alert.status === 'in_progress',
    );
    alertFindMany
      .mockResolvedValueOnce(activeFixtures.map(({ alert }) => alert))
      .mockResolvedValueOnce(activeUnresolvedFixtures.map(({ alert }) => alert));
    const { GET } = await import('@/app/api/assets/route');

    const response = await GET(
      makeRequest(
        '/api/assets?sort=unresolvedCount&page=1&pageSize=10&workspaceId=foreign-workspace',
      ),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toEqual([
      expect.objectContaining({ name: 'zeta.example.invalid', unresolvedCount: 2 }),
      expect.objectContaining({ name: 'shared.example.invalid', unresolvedCount: 1 }),
    ]);
    expect(alertFindMany.mock.calls[0]?.[0]?.where).toEqual({
      teamId: 'active-workspace',
      findingId: { not: 'manual' },
      finding: { asset: { scan: { teamId: 'active-workspace' } } },
    });
    expect(alertFindMany.mock.calls[1]?.[0]?.where).toEqual({
      teamId: 'active-workspace',
      status: { in: ['open', 'in_progress'] },
      findingId: { not: 'manual' },
      finding: { asset: { scan: { teamId: 'active-workspace' } } },
    });
  });

  it.each([
    [
      'unresolvedCount',
      [
        'alpha.example.invalid',
        'beta.example.invalid',
        'zeta.example.invalid',
        'zero.example.invalid',
      ],
    ],
    [
      'unresolvedCount:asc',
      [
        'zero.example.invalid',
        'zeta.example.invalid',
        'alpha.example.invalid',
        'beta.example.invalid',
      ],
    ],
  ] as const)(
    'sorts by %s with zero-count hosts and hostname tie-breaks',
    async (sort, expectedHosts) => {
      alertFindMany
        .mockResolvedValueOnce([
          makeAlert('alpha.example.invalid', null, 'alpha-inventory', 'resolved'),
          makeAlert('beta.example.invalid', null, 'beta-inventory', 'resolved'),
          makeAlert('zeta.example.invalid', null, 'zeta-inventory', 'resolved'),
          makeAlert('zero.example.invalid', null, 'zero-inventory', 'resolved'),
        ])
        .mockResolvedValueOnce([
          makeAlert('beta.example.invalid', null, 'beta-open-1', 'open'),
          makeAlert('beta.example.invalid', null, 'beta-open-2', 'open'),
          makeAlert('beta.example.invalid', null, 'beta-progress', 'in_progress'),
          makeAlert('alpha.example.invalid', null, 'alpha-open-1', 'open'),
          makeAlert('alpha.example.invalid', null, 'alpha-open-2', 'open'),
          makeAlert('alpha.example.invalid', null, 'alpha-progress', 'in_progress'),
          makeAlert('zeta.example.invalid', null, 'zeta-open', 'open'),
        ]);
      const { GET } = await import('@/app/api/assets/route');

      const response = await GET(makeRequest(`/api/assets?sort=${sort}&status=resolved`));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.items.map((item: { name: string }) => item.name)).toEqual(expectedHosts);
      expect(body.items.map((item: { unresolvedCount: number }) => item.unresolvedCount)).toEqual(
        sort === 'unresolvedCount' ? [3, 3, 1, 0] : [0, 1, 3, 3],
      );
    },
  );

  it('uses the active workspace and case-insensitive q while preserving list filters', async () => {
    const { GET } = await import('@/app/api/assets/route');
    const response = await GET(
      makeRequest(
        '/api/assets?q=EXAMPLE&severity=high&status=open&sort=name&page=2&pageSize=10&teamId=other',
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ total: 1 });
    expect(alertFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          teamId: 'active-workspace',
          severity: 'high',
          status: 'open',
          findingId: { not: 'manual' },
          finding: {
            asset: {
              scan: { teamId: 'active-workspace' },
              host: { contains: 'EXAMPLE', mode: 'insensitive' },
            },
          },
        },
      }),
    );
    expect(computeAlertLastActivityAtForList).toHaveBeenCalledWith(
      expect.any(Array),
      'active-workspace',
    );
  });

  it('adds the batched risk change to the active workspace page rows', async () => {
    loadAssetRiskChanges.mockResolvedValueOnce(new Map([['web.example.invalid', 1.25]]));
    const { GET } = await import('@/app/api/assets/route');

    const response = await GET(makeRequest('/api/assets?page=1&pageSize=10&teamId=other'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ name: 'web.example.invalid', riskScoreChange: 1.25 })],
    });
    expect(loadAssetRiskChanges).toHaveBeenCalledWith('active-workspace', ['web.example.invalid']);
  });

  it.each([
    [
      'riskScoreChange',
      [
        'increase.example.invalid',
        'steady-a.example.invalid',
        'steady-b.example.invalid',
        'decrease.example.invalid',
        'null.example.invalid',
      ],
    ],
    [
      'riskScoreChange:asc',
      [
        'decrease.example.invalid',
        'steady-a.example.invalid',
        'steady-b.example.invalid',
        'increase.example.invalid',
        'null.example.invalid',
      ],
    ],
  ] as const)(
    'sorts by %s with numeric order, hostname ties, and nulls last',
    async (sort, expectedHosts) => {
      alertFindMany.mockResolvedValueOnce(
        expectedHosts.map((host) => makeAlert(host, null, `inventory-${host}`)),
      );
      loadAssetRiskChanges.mockResolvedValueOnce(
        new Map([
          ['increase.example.invalid', 2],
          ['decrease.example.invalid', -2],
          ['steady-a.example.invalid', 0],
          ['steady-b.example.invalid', 0],
          ['null.example.invalid', null],
        ]),
      );
      const { GET } = await import('@/app/api/assets/route');

      const response = await GET(makeRequest(`/api/assets?sort=${sort}&page=1&pageSize=5`));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.items.map((item: { name: string }) => item.name)).toEqual(expectedHosts);
      expect(body.items.at(-1)).toEqual(
        expect.objectContaining({ name: 'null.example.invalid', riskScoreChange: null }),
      );
      expect(loadAssetRiskChanges).toHaveBeenCalledWith('active-workspace', expectedHosts);
    },
  );

  it('uses active-workspace risk changes when the URL names another workspace', async () => {
    alertFindMany
      .mockResolvedValueOnce([
        makeAlert('active-riser.example.invalid'),
        makeAlert('active-faller.example.invalid'),
      ])
      .mockResolvedValueOnce([]);
    loadAssetRiskChanges.mockResolvedValueOnce(
      new Map([
        ['active-riser.example.invalid', 2],
        ['active-faller.example.invalid', -1],
      ]),
    );
    const { GET } = await import('@/app/api/assets/route');

    const response = await GET(
      makeRequest('/api/assets?riskTrend=rising&sort=riskScoreChange&teamId=other-workspace'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 1,
      items: [
        expect.objectContaining({ name: 'active-riser.example.invalid', riskScoreChange: 2 }),
      ],
    });
    expect(loadAssetRiskChanges).toHaveBeenCalledWith('active-workspace', [
      'active-riser.example.invalid',
      'active-faller.example.invalid',
    ]);
  });

  it('returns the newest workspace-scoped scan timestamp and null for an unscanned host', async () => {
    alertFindMany.mockResolvedValueOnce([
      makeAlert('scanned.example.invalid', 4, 'alert-scanned'),
      makeAlert('unscanned.example.invalid', 3, 'alert-unscanned'),
    ]);
    assetFindMany.mockResolvedValueOnce([
      makeScanAsset('scanned.example.invalid', '2026-08-01T00:00:00.000Z'),
      makeScanAsset('scanned.example.invalid', '2026-09-15T12:30:00.000Z', 'failed'),
    ]);
    const { GET } = await import('@/app/api/assets/route');

    const response = await GET(makeRequest('/api/assets?sort=name&teamId=other'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [
        {
          name: 'scanned.example.invalid',
          latestScanAt: '2026-09-15T12:30:00.000Z',
          latestScanStatus: 'failed',
        },
        { name: 'unscanned.example.invalid', latestScanAt: null, latestScanStatus: null },
      ],
    });
    expect(assetFindMany).toHaveBeenCalledWith({
      where: {
        host: { in: ['scanned.example.invalid', 'unscanned.example.invalid'] },
        scan: { teamId: 'active-workspace' },
      },
      select: {
        host: true,
        scan: { select: { id: true, teamId: true, startedAt: true, status: true } },
      },
    });
  });

  it('filters by the newest workspace scan status before totals and pagination', async () => {
    alertFindMany.mockResolvedValueOnce([
      makeAlert('alpha.example.invalid'),
      makeAlert('beta.example.invalid'),
      makeAlert('failed.example.invalid'),
      makeAlert('unscanned.example.invalid'),
      makeAlert('foreign-only.example.invalid'),
    ]);
    assetFindMany.mockResolvedValueOnce([
      makeScanAsset('alpha.example.invalid', '2026-10-01T00:00:00.000Z', 'failed', 'alpha-old'),
      makeScanAsset('alpha.example.invalid', '2026-10-07T00:00:00.000Z', 'completed', 'alpha-new'),
      makeScanAsset('alpha.example.invalid', '2026-10-08T00:00:00.000Z', 'running', 'alpha-foreign', 'other-workspace'),
      makeScanAsset('beta.example.invalid', '2026-10-06T00:00:00.000Z', 'completed', 'beta-new'),
      makeScanAsset('failed.example.invalid', '2026-10-07T00:00:00.000Z', 'failed', 'failed-new'),
      makeScanAsset(
        'foreign-only.example.invalid',
        '2026-10-08T00:00:00.000Z',
        'completed',
        'foreign-only-new',
        'other-workspace',
      ),
    ]);
    const { GET } = await import('@/app/api/assets/route');

    const response = await GET(
      makeRequest('/api/assets?latestScanStatus=completed&sort=name&page=2&pageSize=1'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 2,
      items: [
        expect.objectContaining({
          name: 'beta.example.invalid',
          latestScanStatus: 'completed',
        }),
      ],
    });
    expect(assetFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ scan: { teamId: 'active-workspace' } }),
      }),
    );
  });

  it('batches multi-scan history for the active workspace before recency filtering and ordering', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T12:00:00.000Z'));
    alertFindMany
      .mockResolvedValueOnce([
        makeAlert('alpha.example.invalid'),
        makeAlert('beta.example.invalid'),
        makeAlert('foreign-only.example.invalid'),
      ])
      .mockResolvedValueOnce([]);

    const scanFixtures = [
      {
        host: 'alpha.example.invalid',
        workspaceId: 'active-workspace',
        scan: {
          id: 'alpha-latest',
          startedAt: new Date('2026-10-07T12:00:00.000Z'),
          status: 'completed',
        },
      },
      {
        host: 'alpha.example.invalid',
        workspaceId: 'active-workspace',
        scan: {
          id: 'alpha-older',
          startedAt: new Date('2026-10-01T12:00:00.000Z'),
          status: 'failed',
        },
      },
      {
        host: 'alpha.example.invalid',
        workspaceId: 'active-workspace',
        scan: {
          id: 'alpha-older',
          startedAt: new Date('2026-10-01T12:00:00.000Z'),
          status: 'failed',
        },
      },
      {
        host: 'alpha.example.invalid',
        workspaceId: 'other-workspace',
        scan: {
          id: 'alpha-foreign-latest',
          startedAt: new Date('2026-10-08T11:00:00.000Z'),
          status: 'running',
        },
      },
      {
        host: 'beta.example.invalid',
        workspaceId: 'active-workspace',
        scan: {
          id: 'beta-latest',
          startedAt: new Date('2026-10-06T12:00:00.000Z'),
          status: 'completed',
        },
      },
      {
        host: 'foreign-only.example.invalid',
        workspaceId: 'other-workspace',
        scan: {
          id: 'foreign-only-scan',
          startedAt: new Date('2026-10-08T11:00:00.000Z'),
          status: 'completed',
        },
      },
    ];
    assetFindMany.mockImplementation(async (query) => {
      const args = query as {
        where: { host: { in: string[] }; scan: { teamId: string } };
      };
      return scanFixtures
        .filter(
          (fixture) =>
            args.where.host.in.includes(fixture.host) &&
            fixture.workspaceId === args.where.scan.teamId,
        )
        .map(({ host, workspaceId, scan }) => ({ host, scan: { ...scan, teamId: workspaceId } }));
    });

    const { GET } = await import('@/app/api/assets/route');
    const response = await GET(
      makeRequest('/api/assets?scanRecency=last30d&sort=latestScanAt&teamId=other-workspace'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 2,
      items: [
        {
          name: 'alpha.example.invalid',
          scanCount30d: 2,
          latestScanAt: '2026-10-07T12:00:00.000Z',
          latestScanStatus: 'completed',
        },
        {
          name: 'beta.example.invalid',
          scanCount30d: 1,
          latestScanAt: '2026-10-06T12:00:00.000Z',
          latestScanStatus: 'completed',
        },
      ],
    });
    expect(assetFindMany).toHaveBeenCalledTimes(1);
    expect(assetFindMany).toHaveBeenCalledWith({
      where: {
        host: {
          in: ['alpha.example.invalid', 'beta.example.invalid', 'foreign-only.example.invalid'],
        },
        scan: { teamId: 'active-workspace' },
      },
      select: {
        host: true,
        scan: { select: { id: true, teamId: true, startedAt: true, status: true } },
      },
    });
  });

  it('returns an empty never-scanned inventory without querying scan history', async () => {
    alertFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const { GET } = await import('@/app/api/assets/route');

    const response = await GET(makeRequest('/api/assets?neverScanned=true&sort=name'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [], total: 0 });
    expect(assetFindMany).not.toHaveBeenCalled();
  });

  it.each([
    [
      'latestScanAt',
      ['host-new.example.invalid', 'host-old.example.invalid', 'host-never.example.invalid'],
    ],
    [
      'latestScanAt:asc',
      ['host-old.example.invalid', 'host-new.example.invalid', 'host-never.example.invalid'],
    ],
  ] as const)(
    'sorts by %s within the active workspace and keeps hosts without scan history',
    async (sort, expectedHosts) => {
      alertFindMany
        .mockResolvedValueOnce([
          makeAlert('host-new.example.invalid', 9),
          makeAlert('host-old.example.invalid', 5),
          makeAlert('host-never.example.invalid', 6),
          makeAlert('host-low.example.invalid', 4),
        ])
        .mockResolvedValueOnce([]);
      assetFindMany.mockResolvedValueOnce([
        makeScanAsset('host-new.example.invalid', '2026-09-15T12:30:00.000Z'),
        makeScanAsset('host-old.example.invalid', '2026-08-01T00:00:00.000Z'),
        makeScanAsset('host-low.example.invalid', '2026-10-01T00:00:00.000Z'),
      ]);
      const { GET } = await import('@/app/api/assets/route');

      const response = await GET(
        makeRequest(
          `/api/assets?q=host&severity=high&status=open&minRiskScore=5&sort=${sort}&pageSize=10&teamId=other-workspace`,
        ),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.items.map((item: { name: string }) => item.name)).toEqual(expectedHosts);
      expect(body.items.at(-1)).toEqual(
        expect.objectContaining({ name: 'host-never.example.invalid', latestScanAt: null }),
      );
      expect(alertFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            teamId: 'active-workspace',
            severity: 'high',
            status: 'open',
            finding: {
              asset: {
                scan: { teamId: 'active-workspace' },
                host: { contains: 'host', mode: 'insensitive' },
              },
            },
          }),
        }),
      );
      expect(assetFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            host: {
              in: [
                'host-new.example.invalid',
                'host-old.example.invalid',
                'host-never.example.invalid',
                'host-low.example.invalid',
              ],
            },
            scan: { teamId: 'active-workspace' },
          },
        }),
      );
    },
  );

  it.each([
    [
      'latestScanAt',
      [
        'host-new.example.invalid',
        'host-alpha.example.invalid',
        'host-beta.example.invalid',
        'host-old.example.invalid',
        'host-never.example.invalid',
      ],
    ],
    [
      'latestScanAt:asc',
      [
        'host-old.example.invalid',
        'host-alpha.example.invalid',
        'host-beta.example.invalid',
        'host-new.example.invalid',
        'host-never.example.invalid',
      ],
    ],
  ] as const)(
    'uses stable hostname and scan-ID ties for %s while ignoring foreign workspace scans',
    async (sort, expectedHosts) => {
      alertFindMany
        .mockResolvedValueOnce([
          makeAlert('host-new.example.invalid'),
          makeAlert('host-beta.example.invalid'),
          makeAlert('host-alpha.example.invalid'),
          makeAlert('host-old.example.invalid'),
          makeAlert('host-never.example.invalid'),
        ])
        .mockResolvedValueOnce([]);
      assetFindMany.mockResolvedValueOnce([
        makeScanAsset(
          'host-new.example.invalid',
          '2026-10-10T12:00:00.000Z',
          'completed',
          'active-new-scan',
        ),
        makeScanAsset(
          'host-new.example.invalid',
          '2026-10-20T12:00:00.000Z',
          'failed',
          'foreign-newer-scan',
          'other-workspace',
        ),
        makeScanAsset(
          'host-beta.example.invalid',
          '2026-10-09T12:00:00.000Z',
          'completed',
          'scan-z',
        ),
        makeScanAsset(
          'host-beta.example.invalid',
          '2026-10-09T12:00:00.000Z',
          'failed',
          'scan-a',
        ),
        makeScanAsset('host-alpha.example.invalid', '2026-10-09T12:00:00.000Z'),
        makeScanAsset('host-old.example.invalid', '2026-10-08T12:00:00.000Z'),
      ]);
      const { GET } = await import('@/app/api/assets/route');

      const response = await GET(
        makeRequest(`/api/assets?sort=${sort}&pageSize=10&workspaceId=other-workspace`),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.items.map((item: { name: string }) => item.name)).toEqual(expectedHosts);
      expect(
        body.items.find((item: { name: string }) => item.name === 'host-beta.example.invalid'),
      ).toMatchObject({
        latestScanAt: '2026-10-09T12:00:00.000Z',
        latestScanStatus: 'completed',
      });
      expect(body.items.at(-1)).toMatchObject({
        name: 'host-never.example.invalid',
        latestScanAt: null,
        latestScanStatus: null,
      });
      expect(assetFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ scan: { teamId: 'active-workspace' } }),
        }),
      );
    },
  );

  it('keeps the latest scan outcome paired with its timestamp when scan times tie', async () => {
    alertFindMany.mockResolvedValueOnce([makeAlert('tie.example.invalid')]);
    assetFindMany.mockResolvedValueOnce([
      makeScanAsset('tie.example.invalid', '2026-09-15T12:30:00.000Z', 'completed', 'scan-z'),
      makeScanAsset('tie.example.invalid', '2026-09-15T12:30:00.000Z', 'failed', 'scan-a'),
    ]);
    const { GET } = await import('@/app/api/assets/route');

    const response = await GET(makeRequest('/api/assets?sort=name'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [
        {
          name: 'tie.example.invalid',
          latestScanAt: '2026-09-15T12:30:00.000Z',
          latestScanStatus: 'completed',
        },
      ],
    });
  });

  it('counts distinct workspace scans in the inclusive previous 30 days', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T12:00:00.000Z'));
    alertFindMany.mockResolvedValueOnce([makeAlert('host-counted'), makeAlert('host-zero')]);
    assetFindMany.mockResolvedValueOnce([
      makeScanAsset('host-counted', '2026-09-08T12:00:00.000Z', 'completed', 'scan-at-cutoff'),
      makeScanAsset('host-counted', '2026-09-08T12:00:00.000Z', 'completed', 'scan-at-cutoff'),
      makeScanAsset('host-counted', '2026-10-01T00:00:00.000Z', 'failed', 'scan-in-window'),
      makeScanAsset('host-counted', '2026-09-08T11:59:59.999Z', 'completed', 'scan-too-old'),
      makeScanAsset('host-counted', '2026-10-08T12:00:00.001Z', 'running', 'scan-in-future'),
    ]);
    const { GET } = await import('@/app/api/assets/route');

    const response = await GET(makeRequest('/api/assets?sort=name'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [
        { name: 'host-counted', scanCount30d: 2 },
        { name: 'host-zero', scanCount30d: 0 },
      ],
    });
    expect(assetFindMany).toHaveBeenCalledWith({
      where: {
        host: { in: ['host-counted', 'host-zero'] },
        scan: { teamId: 'active-workspace' },
      },
      select: {
        host: true,
        scan: { select: { id: true, teamId: true, startedAt: true, status: true } },
      },
    });
  });

  it('filters the full workspace rollup by scan recency before total and pagination', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T12:00:00.000Z'));
    alertFindMany
      .mockResolvedValueOnce([
        makeAlert('host-recent'),
        makeAlert('host-week'),
        makeAlert('host-old'),
        makeAlert('host-never'),
      ])
      .mockResolvedValueOnce([]);
    assetFindMany.mockResolvedValueOnce([
      makeScanAsset('host-recent', '2026-10-08T11:00:00.000Z'),
      makeScanAsset('host-week', '2026-10-01T12:00:00.000Z'),
      makeScanAsset('host-old', '2026-09-07T12:00:00.000Z'),
    ]);
    const { GET } = await import('@/app/api/assets/route');

    const response = await GET(
      makeRequest('/api/assets?scanRecency=last7d&sort=name&page=1&pageSize=1&teamId=other'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 2,
      items: [expect.objectContaining({ name: 'host-recent' })],
    });
    expect(assetFindMany).toHaveBeenCalledWith({
      where: {
        host: { in: ['host-recent', 'host-week', 'host-old', 'host-never'] },
        scan: { teamId: 'active-workspace' },
      },
      select: {
        host: true,
        scan: { select: { id: true, teamId: true, startedAt: true, status: true } },
      },
    });
  });

  it.each([
    ['last30d', 'host-current', 'host-stale', true],
    ['noRecent30d', 'host-current', 'host-stale', false],
    ['older', 'host-current', 'host-stale', false],
  ] as const)(
    'maps %s to the 30-day freshness boundary before pagination',
    async (filter, currentHost, staleHost, includeCurrent) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-08T12:00:00.000Z'));
      alertFindMany.mockResolvedValueOnce([makeAlert(currentHost), makeAlert(staleHost)]);
      alertFindMany.mockResolvedValueOnce([]);
      assetFindMany.mockResolvedValueOnce([
        makeScanAsset(currentHost, '2026-09-08T12:00:00.000Z'),
        makeScanAsset(staleHost, '2026-09-08T11:59:59.999Z'),
      ]);
      const { GET } = await import('@/app/api/assets/route');

      const response = await GET(makeRequest(`/api/assets?scanRecency=${filter}&sort=name`));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.items.map((item: { name: string }) => item.name)).toEqual(
        includeCurrent ? [currentHost] : [staleHost],
      );
    },
  );

  it('combines old and no-history hosts for noRecent30d while excluding current and future scans', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T12:00:00.000Z'));
    alertFindMany.mockResolvedValueOnce([
      makeAlert('host-current'),
      makeAlert('host-old'),
      makeAlert('host-never'),
      makeAlert('host-future'),
    ]);
    alertFindMany.mockResolvedValueOnce([]);
    assetFindMany.mockResolvedValueOnce([
      makeScanAsset('host-current', '2026-09-08T12:00:00.000Z', 'completed', 'scan-current'),
      makeScanAsset('host-old', '2026-09-08T07:00:00.000Z', 'completed', 'scan-old'),
      makeScanAsset('host-future', '2026-10-08T12:00:00.001Z', 'running', 'scan-future'),
    ]);
    const { GET } = await import('@/app/api/assets/route');

    const response = await GET(
      makeRequest(
        '/api/assets?scanRecency=noRecent30d&q=host&severity=high&status=open&sort=name&page=1&pageSize=10&teamId=other',
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 3,
      items: [
        expect.objectContaining({ name: 'host-future', scanCount30d: 0 }),
        expect.objectContaining({ name: 'host-never', scanCount30d: 0 }),
        expect.objectContaining({ name: 'host-old', scanCount30d: 0 }),
      ],
    });
    expect(assetFindMany).toHaveBeenCalledWith({
      where: {
        host: {
          in: ['host-current', 'host-old', 'host-never', 'host-future'],
        },
        scan: { teamId: 'active-workspace' },
      },
      select: {
        host: true,
        scan: { select: { id: true, teamId: true, startedAt: true, status: true } },
      },
    });
  });

  it.each([
    ['rising', ['host-rising']],
    ['falling', ['host-falling']],
    ['unchanged', ['host-unchanged']],
  ] as const)('filters assets by the %s 30-day risk trend', async (riskTrend, expectedHosts) => {
    alertFindMany.mockResolvedValueOnce([
      makeAlert('host-rising'),
      makeAlert('host-falling'),
      makeAlert('host-unchanged'),
      makeAlert('host-no-history'),
    ]);
    loadAssetRiskChanges.mockResolvedValueOnce(
      new Map([
        ['host-rising', 2],
        ['host-falling', -1],
        ['host-unchanged', 0],
        ['host-no-history', null],
      ]),
    );
    const { GET } = await import('@/app/api/assets/route');

    const response = await GET(makeRequest(`/api/assets?riskTrend=${riskTrend}&sort=name`));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.total).toBe(1);
    expect(body.items.map((item: { name: string }) => item.name)).toEqual(expectedHosts);
    expect(loadAssetRiskChanges).toHaveBeenCalledWith('active-workspace', [
      'host-rising',
      'host-falling',
      'host-unchanged',
      'host-no-history',
    ]);
    expect(alertFindMany.mock.calls[0]?.[0]?.where).toMatchObject({
      teamId: 'active-workspace',
      finding: { asset: { scan: { teamId: 'active-workspace' } } },
    });
  });

  it('filters risk trends before pagination and excludes null history only when active', async () => {
    alertFindMany.mockResolvedValueOnce([
      makeAlert('host-a'),
      makeAlert('host-b'),
      makeAlert('host-c'),
      makeAlert('host-null'),
    ]);
    loadAssetRiskChanges.mockResolvedValueOnce(
      new Map([
        ['host-a', 4],
        ['host-b', 2],
        ['host-c', -1],
        ['host-null', null],
      ]),
    );
    const { GET } = await import('@/app/api/assets/route');

    const response = await GET(
      makeRequest('/api/assets?riskTrend=rising&sort=name&page=2&pageSize=1&teamId=other'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 2,
      items: [expect.objectContaining({ name: 'host-b', riskScoreChange: 2 })],
    });
    expect(loadAssetRiskChanges).toHaveBeenCalledWith('active-workspace', [
      'host-a',
      'host-b',
      'host-c',
      'host-null',
    ]);
  });

  it('accepts blank risk trend as no filter and preserves null-history assets', async () => {
    alertFindMany.mockResolvedValueOnce([makeAlert('host-null')]);
    loadAssetRiskChanges.mockResolvedValueOnce(new Map([['host-null', null]]));
    const { GET } = await import('@/app/api/assets/route');

    const response = await GET(makeRequest('/api/assets?riskTrend=&sort=name'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 1,
      items: [expect.objectContaining({ name: 'host-null', riskScoreChange: null })],
    });
    expect(loadAssetRiskChanges).toHaveBeenCalledWith('active-workspace', ['host-null']);
  });

  it('rejects unsupported risk trend values before reading data', async () => {
    const { GET } = await import('@/app/api/assets/route');

    const response = await GET(makeRequest('/api/assets?riskTrend=spiking'));

    expect(response.status).toBe(400);
    expect(resolveDashboardWorkspaceContext).not.toHaveBeenCalled();
    expect(alertFindMany).not.toHaveBeenCalled();
  });

  it('selects only hosts with no workspace-scoped scan history', async () => {
    alertFindMany
      .mockResolvedValueOnce([makeAlert('host-never'), makeAlert('host-scanned')])
      .mockResolvedValueOnce([]);
    assetFindMany.mockResolvedValueOnce([
      makeScanAsset('host-scanned', '2026-10-08T11:00:00.000Z'),
    ]);
    const { GET } = await import('@/app/api/assets/route');

    const response = await GET(makeRequest('/api/assets?scanRecency=never'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 1,
      items: [
        expect.objectContaining({ name: 'host-never', latestScanAt: null, latestScanStatus: null }),
      ],
    });
  });

  it('combines completed-scan eligibility with active filters and ignores foreign workspace history', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T12:00:00.000Z'));
    alertFindMany
      .mockResolvedValueOnce([
        makeAlert('host-completed', 9),
        makeAlert('host-incomplete', 7),
        makeAlert('host-no-history', 6),
      ])
      .mockResolvedValueOnce([
        { finding: { asset: { host: 'host-incomplete' } } },
        { finding: { asset: { host: 'host-no-history' } } },
      ]);
    assetFindMany.mockResolvedValueOnce([
      makeScanAsset('host-completed', '2026-08-20T00:00:00.000Z', 'completed'),
      makeScanAsset('host-completed', '2026-09-01T00:00:00.000Z', 'failed'),
      makeScanAsset('host-incomplete', '2026-08-25T00:00:00.000Z', 'queued'),
      makeScanAsset('host-incomplete', '2026-08-26T00:00:00.000Z', 'running'),
      makeScanAsset('host-incomplete', '2026-08-27T00:00:00.000Z', 'failed'),
      makeScanAsset(
        'host-no-history',
        '2026-09-02T00:00:00.000Z',
        'completed',
        'foreign-completed-scan',
        'other-workspace',
      ),
    ]);
    loadAssetRiskChanges.mockResolvedValueOnce(
      new Map([
        ['host-incomplete', 2],
        ['host-no-history', 1],
      ]),
    );
    const { GET } = await import('@/app/api/assets/route');

    const response = await GET(
      makeRequest(
        '/api/assets?q=host&severity=high&status=open&minRiskScore=5&scanRecency=noRecent30d&neverScanned=true&riskTrend=rising&alertPresence=with&sort=latestScanAt&page=2&pageSize=1&workspaceId=other-workspace',
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 2,
      items: [expect.objectContaining({ name: 'host-no-history' })],
    });
    expect(alertFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: 'active-workspace',
          severity: 'high',
          status: 'open',
          finding: {
            asset: {
              scan: { teamId: 'active-workspace' },
              host: { contains: 'host', mode: 'insensitive' },
            },
          },
        }),
      }),
    );
    expect(assetFindMany).toHaveBeenCalledWith({
      where: {
        host: { in: ['host-completed', 'host-incomplete', 'host-no-history'] },
        scan: { teamId: 'active-workspace' },
      },
      select: {
        host: true,
        scan: { select: { id: true, teamId: true, startedAt: true, status: true } },
      },
    });
    expect(loadAssetRiskChanges).toHaveBeenCalledWith('active-workspace', [
      'host-incomplete',
      'host-no-history',
    ]);
  });

  it.each([
    'openCount',
    'openCount:asc',
    'unresolvedCount',
    'unresolvedCount:asc',
    'riskScore',
    'riskScore:asc',
    'riskScoreChange',
    'riskScoreChange:asc',
    'latestScanAt',
    'latestScanAt:asc',
    'critical',
    'lastActivity',
    'name',
    'firstSeen',
    'lastSeen',
  ] as const)('paginates never-scanned results with the %s sort', async (sort) => {
    alertFindMany.mockResolvedValueOnce([
      makeAlert('completed-host', 10),
      makeAlert('eligible-a', 8),
      makeAlert('eligible-b', 6),
    ]);
    assetFindMany.mockResolvedValueOnce([
      makeScanAsset('completed-host', '2026-09-01T00:00:00.000Z', 'completed'),
      makeScanAsset('eligible-a', '2026-09-02T00:00:00.000Z', 'failed'),
      makeScanAsset('eligible-b', '2026-09-03T00:00:00.000Z', 'running'),
    ]);
    loadAssetRiskChanges.mockResolvedValue(new Map());
    const { GET } = await import('@/app/api/assets/route');

    const response = await GET(
      makeRequest(`/api/assets?neverScanned=true&sort=${sort}&page=2&pageSize=1`),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(1);
    expect(['eligible-a', 'eligible-b']).toContain(body.items[0]?.name);
  });

  it('does not read assets without an active workspace', async () => {
    resolveDashboardWorkspaceContext.mockResolvedValueOnce(null);
    const { GET } = await import('@/app/api/assets/route');

    const response = await GET(makeRequest('/api/assets'));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'No active workspace' });
    expect(alertFindMany).not.toHaveBeenCalled();
  });

  it('treats a blank hostname query as an unfiltered inventory read', async () => {
    const { GET } = await import('@/app/api/assets/route');

    const response = await GET(makeRequest('/api/assets?q=%20%20'));

    expect(response.status).toBe(200);
    const where = alertFindMany.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({
      finding: { asset: { scan: { teamId: 'active-workspace' } } },
    });
    expect(where.finding.asset).not.toHaveProperty('host');
  });

  it('preserves authentication failures before resolving workspace or reading data', async () => {
    requireTeamRole.mockRejectedValueOnce(
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
    );
    const { GET } = await import('@/app/api/assets/route');

    const response = await GET(makeRequest('/api/assets'));

    expect(response.status).toBe(401);
    expect(resolveDashboardWorkspaceContext).not.toHaveBeenCalled();
    expect(alertFindMany).not.toHaveBeenCalled();
  });

  it.each([
    ['riskScore', ['host-max', 'host-alpha', 'host-zeta', 'host-zero', 'host-null']],
    ['riskScore:asc', ['host-zero', 'host-alpha', 'host-zeta', 'host-max', 'host-null']],
  ] as const)(
    'sorts by %s with max-score reduction and nulls last',
    async (sort, expectedHosts) => {
      alertFindMany.mockResolvedValueOnce([
        makeAlert('host-zeta', 3, 'alert-zeta-3'),
        makeAlert('host-alpha', 3, 'alert-alpha-3'),
        makeAlert('host-max', 8, 'alert-max-8'),
        makeAlert('host-max', null, 'alert-max-null'),
        makeAlert('host-zero', 0, 'alert-zero-0'),
        makeAlert('host-null', null, 'alert-null-null'),
      ]);
      const { GET } = await import('@/app/api/assets/route');

      const response = await GET(makeRequest(`/api/assets?sort=${sort}`));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.items.map((item: { name: string }) => item.name)).toEqual(expectedHosts);
      expect(body.items.find((item: { name: string }) => item.name === 'host-max')?.riskScore).toBe(
        8,
      );
      expect(
        body.items.find((item: { name: string }) => item.name === 'host-zero')?.riskScore,
      ).toBe(0);
      expect(
        body.items.find((item: { name: string }) => item.name === 'host-null')?.riskScore,
      ).toBeNull();
    },
  );

  it('rejects an unsupported risk sort value', async () => {
    const { GET } = await import('@/app/api/assets/route');

    const response = await GET(makeRequest('/api/assets?sort=riskScore:sideways'));

    expect(response.status).toBe(400);
    expect(alertFindMany).not.toHaveBeenCalled();
  });

  it.each(['-0.1', '10.1', 'not-a-number', 'Infinity', 'NaN'])(
    'rejects invalid minimum risk score %s before reading data',
    async (minRiskScore) => {
      const { GET } = await import('@/app/api/assets/route');

      const response = await GET(makeRequest(`/api/assets?minRiskScore=${minRiskScore}`));

      expect(response.status).toBe(400);
      expect(resolveDashboardWorkspaceContext).not.toHaveBeenCalled();
      expect(alertFindMany).not.toHaveBeenCalled();
    },
  );

  it('filters completed host rollups by minimum score, including equality and excluding nulls', async () => {
    alertFindMany.mockResolvedValueOnce([
      makeAlert('host-low', 4, 'alert-low'),
      makeAlert('host-equal', 5, 'alert-equal'),
      makeAlert('host-high', 8, 'alert-high'),
      makeAlert('host-high', 6, 'alert-high-lower'),
      makeAlert('host-null', null, 'alert-null'),
    ]);
    const { GET } = await import('@/app/api/assets/route');

    const response = await GET(
      makeRequest('/api/assets?minRiskScore=5&teamId=other&sort=riskScore:asc&pageSize=1'),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.total).toBe(2);
    expect(body.items).toEqual([expect.objectContaining({ name: 'host-equal', riskScore: 5 })]);
    expect(alertFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: 'active-workspace',
          finding: { asset: { scan: { teamId: 'active-workspace' } } },
        }),
      }),
    );
    const where = alertFindMany.mock.calls[0]?.[0]?.where;
    expect(where).not.toHaveProperty('finding.asset.priorityScore');
  });

  it('accepts a zero minimum and treats an empty value as no threshold', async () => {
    alertFindMany.mockResolvedValueOnce([
      makeAlert('host-zero', 0, 'alert-zero'),
      makeAlert('host-null', null, 'alert-null'),
    ]);
    const { GET } = await import('@/app/api/assets/route');

    const response = await GET(makeRequest('/api/assets?minRiskScore=0'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ total: 1 });

    alertFindMany.mockResolvedValueOnce([makeAlert('host-null', null, 'alert-null-2')]);
    const emptyValueResponse = await GET(makeRequest('/api/assets?minRiskScore='));
    expect(emptyValueResponse.status).toBe(200);
    await expect(emptyValueResponse.json()).resolves.toMatchObject({ total: 1 });
  });
});
