import { describe, expect, it } from 'vitest';
import {
  buildAlertDetailHref,
  buildAlertReturnHref,
  type AlertSearchParams,
} from '@/lib/business/alerts-navigation';

function toSearchParamRecord(params: URLSearchParams): AlertSearchParams {
  const values = new Map<string, string[]>();
  for (const [key, value] of params) {
    const entries = values.get(key) ?? [];
    entries.push(value);
    values.set(key, entries);
  }

  return Object.fromEntries(
    [...values].map(([key, entries]) => [key, entries.length === 1 ? entries[0] : entries]),
  );
}

describe('alert list/detail navigation', () => {
  it('round-trips every list query parameter, including filters, sort, page, and repeated keys', () => {
    const originalQuery =
      'severity=critical%2Chigh&status=open&sort=created&page=3&asset=api.example%3A443%2Ftcp&q=api+gateway&tag=one&tag=two&selected=alert-1';
    const detailUrl = new URL(
      buildAlertDetailHref('alert-1', originalQuery),
      'https://vulnaware.example',
    );

    expect([...detailUrl.searchParams]).toEqual([...new URLSearchParams(originalQuery)]);

    const returnHref = buildAlertReturnHref(toSearchParamRecord(detailUrl.searchParams));
    const returnedUrl = new URL(returnHref, 'https://vulnaware.example');
    expect(returnedUrl.pathname).toBe('/alerts');
    expect([...returnedUrl.searchParams]).toEqual([...new URLSearchParams(originalQuery)]);
  });

  it('returns to the unfiltered list when a detail has no query context', () => {
    expect(buildAlertDetailHref('alert-1', '')).toBe('/alerts/alert-1');
    expect(buildAlertReturnHref({})).toBe('/alerts');
  });
});
