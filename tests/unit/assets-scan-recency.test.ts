import { describe, expect, it } from 'vitest';
import {
  formatAssetScanAge,
  matchesAssetScanRecency,
  NO_SCAN_HISTORY_LABEL,
} from '@/lib/business/assets-scan-recency';

const NOW = new Date('2026-10-08T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('matchesAssetScanRecency', () => {
  it('keeps every timestamp, including null history, in the all bucket', () => {
    expect(matchesAssetScanRecency(null, 'all', NOW)).toBe(true);
    expect(matchesAssetScanRecency(new Date('2020-01-01T00:00:00Z'), 'all', NOW)).toBe(true);
  });

  it.each([
    ['last24h', DAY],
    ['last7d', 7 * DAY],
    ['last30d', 30 * DAY],
  ] as const)('includes the exact %s cutoff and excludes older timestamps', (filter, window) => {
    const cutoff = new Date(NOW.getTime() - window);
    expect(matchesAssetScanRecency(cutoff, filter, NOW, filter === 'last30d' ? 1 : undefined)).toBe(
      true,
    );
    expect(
      matchesAssetScanRecency(
        new Date(cutoff.getTime() - 1),
        filter,
        NOW,
        filter === 'last30d' ? 0 : undefined,
      ),
    ).toBe(false);
  });

  it('uses the distinct workspace-scoped 30-day count for the binary window modes', () => {
    const cutoff = new Date(NOW.getTime() - 30 * DAY);
    expect(matchesAssetScanRecency(cutoff, 'last30d', NOW, 1)).toBe(true);
    expect(matchesAssetScanRecency(new Date('2026-10-08T13:00:00Z'), 'last30d', NOW, 0)).toBe(false);
    expect(matchesAssetScanRecency(null, 'noRecent30d', NOW, 0)).toBe(true);
    expect(matchesAssetScanRecency(new Date('2026-09-01T00:00:00Z'), 'noRecent30d', NOW, 0)).toBe(
      true,
    );
    expect(matchesAssetScanRecency(new Date('2026-09-08T12:00:00Z'), 'noRecent30d', NOW, 1)).toBe(
      false,
    );
    expect(matchesAssetScanRecency(new Date('2026-10-08T13:00:00Z'), 'noRecent30d', NOW, 0)).toBe(
      true,
    );
  });

  it('matches only timestamps older than the 30-day cutoff in older', () => {
    const cutoff = new Date(NOW.getTime() - 30 * DAY);
    expect(matchesAssetScanRecency(new Date(cutoff.getTime() - 1), 'older', NOW)).toBe(true);
    expect(matchesAssetScanRecency(cutoff, 'older', NOW)).toBe(false);
  });

  it('keeps null history only in the no-history bucket and excludes it from dated buckets', () => {
    expect(matchesAssetScanRecency(null, 'never', NOW)).toBe(true);
    expect(matchesAssetScanRecency(new Date('2026-10-08T11:59:59Z'), 'never', NOW)).toBe(false);
    expect(matchesAssetScanRecency(null, 'last24h', NOW)).toBe(false);
    expect(matchesAssetScanRecency(null, 'last7d', NOW)).toBe(false);
    expect(matchesAssetScanRecency(null, 'last30d', NOW)).toBe(false);
    expect(matchesAssetScanRecency(null, 'noRecent30d', NOW, 0)).toBe(true);
    expect(matchesAssetScanRecency(null, 'older', NOW)).toBe(false);
  });
});

describe('formatAssetScanAge', () => {
  it('reports explicit no-history state for null timestamps', () => {
    expect(formatAssetScanAge(null, NOW)).toBe(NO_SCAN_HISTORY_LABEL);
  });

  it.each([
    ['just now', '2026-10-08T11:59:30.000Z', 'Just now'],
    ['sub-hour age', '2026-10-08T11:15:00.000Z', '45 minutes ago'],
    ['hour age', '2026-10-08T09:00:00.000Z', '3 hours ago'],
    ['day age', '2026-10-06T12:00:00.000Z', '2 days ago'],
  ])('formats the %s boundary', (_label, value, expected) => {
    expect(formatAssetScanAge(value, NOW)).toBe(expected);
  });

  it('clamps a future timestamp to the safe current state', () => {
    expect(formatAssetScanAge('2026-10-08T13:00:00.000Z', NOW)).toBe('Just now');
  });
});
