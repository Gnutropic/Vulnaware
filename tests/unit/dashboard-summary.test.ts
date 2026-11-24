// @vitest-environment node
// @polsia:user-owned — Summary ownership count stays empty without an active roster row.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDashboardSummary } from '@/lib/business/dashboard-summary';

const { alertCount } = vi.hoisted(() => ({ alertCount: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: { alert: { count: alertCount } } }));

describe('loadDashboardSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    alertCount.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      if (
        typeof where.status === 'object' &&
        where.status !== null &&
        'in' in where.status &&
        Array.isArray(where.status.in) &&
        where.status.in.join(',') === 'open,in_progress'
      ) {
        return 2;
      }
      if ('snoozedUntil' in where) return 1;
      if (where.status === 'resolved') return 3;
      return 0;
    });
  });

  it('reports no owned alerts when the active workspace has no caller roster row', async () => {
    await expect(
      loadDashboardSummary('active-workspace', null, new Date('2026-09-29T12:00:00Z')),
    ).resolves.toEqual({ open: 2, ownedByMe: 0, snoozed: 1, resolvedThisWeek: 3 });

    expect(alertCount).toHaveBeenCalledTimes(3);
    expect(alertCount).toHaveBeenCalledWith({
      where: { teamId: 'active-workspace', status: { in: ['open', 'in_progress'] } },
    });
    expect(alertCount).not.toHaveBeenCalledWith({
      where: { teamId: 'active-workspace', ownerId: null },
    });
  });
});
