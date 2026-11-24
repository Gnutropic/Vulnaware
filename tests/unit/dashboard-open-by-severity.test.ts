// @vitest-environment node
// @polsia:user-owned — Open-alert severity aggregation coverage.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOpenAlertCountsBySeverity } from '@/lib/business/dashboard-open-by-severity';

const { alertGroupBy } = vi.hoisted(() => ({ alertGroupBy: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: { alert: { groupBy: alertGroupBy } } }));

describe('loadOpenAlertCountsBySeverity', () => {
  const now = new Date('2026-10-05T12:00:00Z');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('zero-fills every severity bucket when the workspace has no matching alerts', async () => {
    alertGroupBy.mockResolvedValue([]);

    await expect(loadOpenAlertCountsBySeverity('workspace-empty', now)).resolves.toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    });
  });

  it('scopes the query to the workspace and coalesces unknown, null, and low severities', async () => {
    alertGroupBy.mockResolvedValue([
      { severity: 'critical', _count: 2 },
      { severity: 'high', _count: 3 },
      { severity: 'medium', _count: 4 },
      { severity: 'low', _count: 5 },
      { severity: 'legacy-value', _count: 6 },
      { severity: null, _count: 7 },
    ]);

    await expect(loadOpenAlertCountsBySeverity('workspace-selected', now)).resolves.toEqual({
      critical: 2,
      high: 3,
      medium: 4,
      low: 18,
    });

    expect(alertGroupBy).toHaveBeenCalledWith({
      by: ['severity'],
      where: {
        teamId: 'workspace-selected',
        status: 'open',
        remediatedAt: null,
        OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
      },
      _count: true,
    });
  });
});
