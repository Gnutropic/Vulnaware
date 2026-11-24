// @vitest-environment node
// Unit tests for the `q=` search filter on GET /api/alerts.
// Covers: CVE id substring match, vulnerability title (CveEntry.description)
// substring match, empty/whitespace input (zod trims + drops).
//
// Architecture note: the route delegates all search work to
// `@/lib/business/alerts-search` (buildAlertSearchWhere +
// batchFetchAlertVulnerabilityTitles). We mock the `@/lib/db` prisma
// singleton AND the `@/lib/business/alerts-search` module so tests can
// assert on the WHERE clause fed into `prisma.alert.findMany` without
// spinning up a real database.

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
const computeAlertLastActivityAtForListMock = vi.fn();

vi.mock('@/lib/business/alerts-activity', () => ({
  computeAlertLastActivityAtForList: computeAlertLastActivityAtForListMock,
}));

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

// Mock the alerts-search module so tests can spy/control the resolved
// WHERE clause without invoking real DB queries.
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

function makeAlert(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-1',
    teamId: 'team-1',
    findingId: 'finding-1',
    severity: 'high',
    status: 'open',
    source: 'kev',
    assigneeId: null,
    ownerId: null,
    snoozedUntil: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    acknowledgedAt: null,
    finding: {
      cveId: 'CVE-2021-44228',
      asset: { host: 'host.example.com', port: 8080, protocol: 'tcp' },
      scan: { source: 'scheduled' },
    },
    ...overrides,
  };
}

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
  computeAlertLastActivityAtForListMock.mockReset();
  buildAlertSearchWhereMock.mockReset();
  batchFetchAlertVulnerabilityTitlesMock.mockReset();
  requireTeamRoleMock.mockReset();

  requireTeamRoleMock.mockResolvedValue(makeCtx());
  alertGroupBy.mockResolvedValue([]);
  alertCommentGroupBy.mockResolvedValue([]);
  vulnerabilityTrendFindFirst.mockResolvedValue(null);
  workspaceMemberFindMany.mockResolvedValue([]);
  userFindMany.mockResolvedValue([]);
  computeAlertLastActivityAtForListMock.mockResolvedValue(new Map());
  cveEntryFindMany.mockResolvedValue([]);

  // Default: search helper returns no-op {} and titles map is empty
  buildAlertSearchWhereMock.mockResolvedValue({});
  batchFetchAlertVulnerabilityTitlesMock.mockResolvedValue(new Map());
});

describe('GET /api/alerts — q= search filter', () => {
  it('test 1: CVE id substring match (q=log4j) calls buildAlertSearchWhere and includes contains+insensitive cveId OR arm', async () => {
    // Arrange: search helper resolves with an OR clause on cveId via the
    // contains+insensitive arm (case-insensitive SUBSTRING; the case-fold
    // rides on Prisma, NOT a request-time toUpperCase). The downstream
    // route forwards this literal verbatim into where.finding.OR.
    const searchWhere = {
      finding: {
        OR: [{ cveId: { contains: 'log4j', mode: 'insensitive' } }],
      },
    };
    buildAlertSearchWhereMock.mockResolvedValueOnce(searchWhere);
    alertFindMany.mockResolvedValueOnce([makeAlert()]);
    alertCount.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?q=log4j'));
    expect(res.status).toBe(200);

    // Assert: buildAlertSearchWhere was called with the trimmed query
    expect(buildAlertSearchWhereMock).toHaveBeenCalledWith('log4j');

    // Assert: the findMany WHERE includes a `finding` clause with the OR
    // arm shaped exactly as the helper emitted — contains-mode + insensitive.
    // The brief widens the cveId arm to substring so a typed `CVE-2024-`
    // prefix matches every cveId starting with that prefix.
    const findManyCall = alertFindMany.mock.calls[0][0] as {
      where: { finding?: { OR?: unknown[] } };
    };
    expect(findManyCall.where.finding).toBeDefined();
    const orArms = findManyCall.where.finding?.OR as Array<Record<string, unknown>>;
    expect(orArms).toBeDefined();
    expect(
      orArms.some((arm) => {
        const cveArm = arm as { cveId?: { contains?: string; mode?: string } };
        return cveArm.cveId?.contains === 'log4j' && cveArm.cveId?.mode === 'insensitive';
      }),
    ).toBe(true);
  });

  it('test 2: vulnerability title match q=deserialization calls buildAlertSearchWhere and includes description-based OR arm', async () => {
    // Arrange: search helper resolves with cveId-based match (from description lookup)
    const searchWhere = {
      finding: {
        OR: [
          { cveId: { contains: 'deserialization', mode: 'insensitive' } },
          { cveId: { in: ['CVE-2021-44228'] } },
        ],
      },
    };
    buildAlertSearchWhereMock.mockResolvedValueOnce(searchWhere);
    alertFindMany.mockResolvedValueOnce([makeAlert()]);
    alertCount.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?q=deserialization'));
    expect(res.status).toBe(200);

    // Assert: buildAlertSearchWhere was called with the trimmed query
    expect(buildAlertSearchWhereMock).toHaveBeenCalledWith('deserialization');

    // Assert: both OR arms present in the forwarded finding clause
    const findManyCall = alertFindMany.mock.calls[0][0] as {
      where: { finding?: { OR?: unknown[] } };
    };
    const orArms = findManyCall.where.finding?.OR as Array<Record<string, unknown>>;
    expect(orArms).toHaveLength(2);

    const inArm = orArms.find((arm) => {
      const a = arm as { cveId?: { in?: string[] } };
      return Array.isArray(a.cveId?.in);
    }) as { cveId: { in: string[] } } | undefined;
    expect(inArm).toBeDefined();
    expect(inArm?.cveId.in).toContain('CVE-2021-44228');
  });

  it('test 3: whitespace-only q fails zod validation so buildAlertSearchWhere is NOT called and the route returns 400', async () => {
    // AlertQuery.parse with q='   ' fails because trim() produces '' and
    // .min(1) rejects. The failing parse short-circuits BEFORE the helper
    // is called, so the routes 400 (and the helper's mock is never invoked).
    const { AlertQuery } = await import('@/lib/contracts/alerts');
    const result = AlertQuery.safeParse({ q: '   ' });
    expect(result.success).toBe(false);

    // Sanity check: when `q` is absent or empty-string, the parse succeeds
    // with q as undefined — that is the "no filter" path.
    const emptyResult = AlertQuery.safeParse({});
    expect(emptyResult.success).toBe(true);
    if (emptyResult.success) {
      expect(emptyResult.data.q).toBeUndefined();
    }

    // Flow-level: a whitespace-only q in the URL must NOT call
    // buildAlertSearchWhere at all — zod fails the parse before the
    // helper runs, so the route returns 400 and never invokes the OR
    // builder.
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?q=+++'));
    expect(res.status).toBe(400);
    expect(buildAlertSearchWhereMock).not.toHaveBeenCalled();
  });

  it('test 4: canonical CVE id q=CVE-2021-44228 forwards a contains+insensitive OR arm (case preserved verbatim in the URL)', async () => {
    // The cveId arm is widened to a case-insensitive SUBSTRING match —
    // `contains` + `mode: 'insensitive'`. Canonical uppercase input
    // still produces the same shape, so a writer that always sends the
    // canonical form sees exactly the same forwarded literal as a writer
    // that pre-folds to lowercase.
    const searchWhere = {
      finding: {
        OR: [{ cveId: { contains: 'CVE-2021-44228', mode: 'insensitive' } }],
      },
    };
    buildAlertSearchWhereMock.mockResolvedValueOnce(searchWhere);
    alertFindMany.mockResolvedValueOnce([makeAlert()]);
    alertCount.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?q=CVE-2021-44228'));
    expect(res.status).toBe(200);

    // Assert: helper called verbatim with the canonical case.
    expect(buildAlertSearchWhereMock).toHaveBeenCalledWith('CVE-2021-44228');

    // Assert: the findMany WHERE carries the canonical-case contains-arm.
    const findManyCall = alertFindMany.mock.calls[0][0] as {
      where: { finding?: { OR?: unknown[] } };
    };
    const orArms = findManyCall.where.finding?.OR as Array<Record<string, unknown>>;
    expect(orArms).toBeDefined();
    expect(
      orArms.some((arm) => {
        const cveArm = arm as { cveId?: { contains?: string; mode?: string } };
        return cveArm.cveId?.contains === 'CVE-2021-44228' && cveArm.cveId?.mode === 'insensitive';
      }),
    ).toBe(true);
  });

  it('hostname search is a case-insensitive partial asset match inside the active workspace', async () => {
    const searchWhere = {
      finding: {
        asset: { host: { contains: 'api.example', mode: 'insensitive' } },
      },
    };
    buildAlertSearchWhereMock.mockResolvedValueOnce(searchWhere);
    alertFindMany.mockResolvedValueOnce([makeAlert()]);
    alertCount.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(
      makeRequest(
        'http://test/api/alerts?hostname=api.example&severity=critical&sort=created_asc',
      ),
    );
    expect(res.status).toBe(200);
    expect(buildAlertSearchWhereMock).toHaveBeenCalledWith(undefined, 'api.example');

    const listWhere = alertFindMany.mock.calls[0]?.[0]?.where as Record<string, unknown>;
    expect(listWhere).toEqual(
      expect.objectContaining({
        teamId: 'team-1',
        severity: { in: ['critical'] },
        finding: searchWhere.finding,
      }),
    );
    expect(alertFindMany.mock.calls[0]?.[0]?.orderBy).toEqual([
      { createdAt: 'asc' },
      { id: 'asc' },
    ]);
  });

  it('test 5: lowercase cve-2021-44228 still matches — helper receives the lowercase string and routes the same contains+insensitive arm', async () => {
    // The case-fold rides Prisma's `mode: 'insensitive'`, NOT a request-
    // time toUpperCase. The URL contract stays literal: a non-canonical
    // lowercase query is forwarded verbatim and Prisma matches both
    // canonical and lowercase rows under the same WHERE literal.
    const searchWhere = {
      finding: {
        OR: [{ cveId: { contains: 'cve-2021-44228', mode: 'insensitive' } }],
      },
    };
    buildAlertSearchWhereMock.mockResolvedValueOnce(searchWhere);
    alertFindMany.mockResolvedValueOnce([makeAlert()]);
    alertCount.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?q=cve-2021-44228'));
    expect(res.status).toBe(200);

    // Assert: helper called verbatim with the lowercase string (no
    // request-time toUpperCase — the case-fold is Prisma's job).
    expect(buildAlertSearchWhereMock).toHaveBeenCalledWith('cve-2021-44228');

    // Assert: forwarded arm carries the lowercase contains-value with
    // mode: 'insensitive' — same shape as the canonical-case arm.
    const findManyCall = alertFindMany.mock.calls[0][0] as {
      where: { finding?: { OR?: unknown[] } };
    };
    const orArms = findManyCall.where.finding?.OR as Array<Record<string, unknown>>;
    expect(orArms).toBeDefined();
    expect(
      orArms.some((arm) => {
        const cveArm = arm as { cveId?: { contains?: string; mode?: string } };
        return cveArm.cveId?.contains === 'cve-2021-44228' && cveArm.cveId?.mode === 'insensitive';
      }),
    ).toBe(true);
  });
});

// ===================== hideSnoozed (literal '1') composition =====================
//
// hideSnoozed's wire shape is the literal `'1'` (NOT `'true'`). Default
// = snoozed rows visible (no OR arm); `?hideSnoozed=1` slices in the two
// OR siblings `(snoozedUntil IS NULL OR snoozedUntil <= now)`. Locking
// these assertions in the q-search composition family proves the
// q + hideSnoozed composition family stays in lockstep with the
// hideSnoozed arm shapes the brief calls out.

describe('GET /api/alerts — q= + ?hideSnoozed=1 composition', () => {
  it('q present, no hideSnoozed → finding.OR arms present, top-level OR is empty', async () => {
    const searchWhere = {
      finding: {
        OR: [{ cveId: { contains: 'log4j', mode: 'insensitive' } }],
      },
    };
    buildAlertSearchWhereMock.mockResolvedValueOnce(searchWhere);
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?q=log4j'));
    expect(res.status).toBe(200);

    const findManyCall = alertFindMany.mock.calls[0][0] as {
      where: {
        finding?: { OR?: unknown[] };
        OR?: Array<Record<string, unknown>>;
      };
    };
    // q search arms hoist into the nested `finding.OR`.
    expect(findManyCall.where.finding?.OR).toBeDefined();
    // hideSnoozed absent → no snooze arms at the top-level OR.
    const topOrArms = findManyCall.where.OR ?? [];
    const hasSnoozedArm = topOrArms.some(
      (a) =>
        (a as { snoozedUntil?: unknown }).snoozedUntil === null ||
        typeof (a as { snoozedUntil?: { lte?: Date } }).snoozedUntil?.lte === 'object',
    );
    expect(hasSnoozedArm).toBe(false);
  });

  it('q present + hideSnoozed=1 → both finding.OR + top-level OR coexist', async () => {
    const searchWhere = {
      finding: {
        OR: [{ cveId: { contains: 'log4j', mode: 'insensitive' } }],
      },
    };
    buildAlertSearchWhereMock.mockResolvedValueOnce(searchWhere);
    alertFindMany.mockResolvedValueOnce([]);
    alertCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/alerts/route');
    const res = await GET(makeRequest('http://test/api/alerts?q=log4j&hideSnoozed=1'));
    expect(res.status).toBe(200);

    const findManyCall = alertFindMany.mock.calls[0][0] as {
      where: {
        finding?: { OR?: unknown[] };
        OR?: Array<Record<string, unknown>>;
      };
    };
    // q search arms still hoist into the nested `finding.OR`.
    expect(findManyCall.where.finding?.OR).toBeDefined();
    // hideSnoozed=on → both snooze arms (null, lte) splice into the
    // top-level OR alongside the other sibling filters.
    const topOrArms = findManyCall.where.OR ?? [];
    const nullArm = topOrArms.find((a) => (a as { snoozedUntil?: unknown }).snoozedUntil === null);
    const lteArm = topOrArms.find(
      (a) =>
        typeof (a as { snoozedUntil?: { lte?: Date } }).snoozedUntil?.lte === 'object' &&
        (a as { snoozedUntil?: { lte?: Date } }).snoozedUntil?.lte instanceof Date,
    );
    expect(nullArm).toBeDefined();
    expect(lteArm).toBeDefined();
  });
});
