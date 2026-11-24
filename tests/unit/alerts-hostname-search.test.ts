// @vitest-environment node
// Direct coverage for the dedicated /alerts hostname predicate. The route
// tests cover workspace and severity/sort composition; this file locks the
// helper's case-insensitive partial-match shape and its AND composition with q.

import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const cveEntryFindMany = vi.fn();
vi.mock('@/lib/db', () => ({
  prisma: { cveEntry: { findMany: cveEntryFindMany } },
}));

describe('buildAlertSearchWhere hostname filtering', () => {
  it('builds a case-insensitive partial asset-host predicate without a CVE lookup', async () => {
    const { buildAlertSearchWhere } = await import('@/lib/business/alerts-search');

    await expect(buildAlertSearchWhere(undefined, 'Api.Example')).resolves.toEqual({
      finding: {
        asset: { host: { contains: 'Api.Example', mode: 'insensitive' } },
      },
    });
    expect(cveEntryFindMany).not.toHaveBeenCalled();
  });

  it('keeps hostname as an AND sibling when the existing q search is present', async () => {
    cveEntryFindMany.mockResolvedValueOnce([]);
    const { buildAlertSearchWhere } = await import('@/lib/business/alerts-search');

    await expect(buildAlertSearchWhere('CVE-2026', 'api.example')).resolves.toEqual({
      finding: {
        OR: [
          { cveId: { contains: 'CVE-2026', mode: 'insensitive' } },
          { asset: { host: { contains: 'CVE-2026', mode: 'insensitive' } } },
        ],
        asset: { host: { contains: 'api.example', mode: 'insensitive' } },
      },
    });
  });
});
