// @polsia:user-owned — Inclusive date-only bounds and precise timestamp bounds.
import { describe, expect, it } from 'vitest';
import { buildAlertCreatedAtRange } from '@/lib/business/alerts-created-at-range';

describe('buildAlertCreatedAtRange', () => {
  it('uses UTC day boundaries so the end calendar date is inclusive', () => {
    expect(buildAlertCreatedAtRange('2026-10-10', '2026-10-11')).toEqual({
      gte: new Date('2026-10-10T00:00:00.000Z'),
      lt: new Date('2026-10-12T00:00:00.000Z'),
    });
  });

  it('keeps an explicit ISO timestamp as an exact upper bound', () => {
    expect(buildAlertCreatedAtRange(undefined, '2026-10-11T09:30:00.000Z')).toEqual({
      lte: new Date('2026-10-11T09:30:00.000Z'),
    });
  });

  it('omits the date predicate when both bounds are cleared', () => {
    expect(buildAlertCreatedAtRange('', '')).toBeUndefined();
  });
});
