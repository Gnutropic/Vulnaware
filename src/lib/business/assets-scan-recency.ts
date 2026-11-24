// @polsia:user-owned — Pure scan-recency matching for the /assets inventory.
// Keep the cutoff and null-history semantics here so the API and focused tests
// use exactly the same boundary rules.

import type { AssetScanRecency } from '@/lib/contracts/assets';

const HOURS_PER_DAY = 24;
const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;
const MILLISECONDS_PER_MINUTE = 60 * 1000;
const MILLISECONDS_PER_DAY = HOURS_PER_DAY * MILLISECONDS_PER_HOUR;

export const NO_SCAN_HISTORY_LABEL = 'No scans recorded for this asset.';

export function matchesAssetScanRecency(
  latestScanAt: Date | null,
  scanRecency: AssetScanRecency,
  now: Date,
  scanCount30d?: number,
): boolean {
  if (scanRecency === 'all') return true;
  if (scanRecency === 'never') return latestScanAt === null;
  if (scanRecency === 'last30d' || scanRecency === 'noRecent30d') {
    // The API and CSV adapter pass a workspace-scoped distinct count for the
    // 30-day modes. Keep a timestamp fallback for direct callers that use the
    // legacy matcher signature; future timestamps are outside the window.
    const cutoff = now.getTime() - 30 * MILLISECONDS_PER_DAY;
    const hasRecentScan =
      scanCount30d !== undefined
        ? scanCount30d > 0
        : latestScanAt !== null &&
          latestScanAt.getTime() >= cutoff &&
          latestScanAt.getTime() <= now.getTime();
    return scanRecency === 'last30d' ? hasRecentScan : !hasRecentScan;
  }
  if (latestScanAt === null) return false;

  const days = scanRecency === 'last24h' ? 1 : scanRecency === 'last7d' ? 7 : 30;
  const cutoff = now.getTime() - days * HOURS_PER_DAY * MILLISECONDS_PER_HOUR;

  if (scanRecency === 'older') return latestScanAt.getTime() < cutoff;
  return latestScanAt.getTime() >= cutoff;
}

/**
 * Format the age of an asset's newest scan using a stable, coarse-grained
 * ladder that remains readable in both the mobile cards and desktop table.
 * Future timestamps are treated as current so clock skew cannot show a
 * misleading future age.
 */
export function formatAssetScanAge(value: string | Date | null, now: Date): string {
  if (value === null) return NO_SCAN_HISTORY_LABEL;

  const timestamp = typeof value === 'string' ? new Date(value).getTime() : value.getTime();
  const nowTimestamp = now.getTime();
  if (Number.isNaN(timestamp) || Number.isNaN(nowTimestamp)) return NO_SCAN_HISTORY_LABEL;

  const elapsed = Math.max(0, nowTimestamp - timestamp);
  if (elapsed < MILLISECONDS_PER_MINUTE) return 'Just now';

  const minutes = Math.floor(elapsed / MILLISECONDS_PER_MINUTE);
  if (elapsed < MILLISECONDS_PER_HOUR) {
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }

  const hours = Math.floor(elapsed / MILLISECONDS_PER_HOUR);
  if (elapsed < MILLISECONDS_PER_DAY) {
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }

  const days = Math.floor(elapsed / MILLISECONDS_PER_DAY);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
