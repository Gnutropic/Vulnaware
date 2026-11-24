import { describe, expect, it } from 'vitest';
import { buildAssetQueryString, parseAssetPageFilters } from '@/lib/business/assets-url-state';

const incomingQuery =
  'q=api.example.test&severity=high&status=open&minRiskScore=5&scanRecency=noRecent30d&latestScanStatus=failed&neverScanned=true&riskTrend=rising&alertPresence=with&sort=riskScore%3Aasc&page=3&pageSize=20';

describe('/assets URL filter state', () => {
  it('restores a direct-link selection on reload and preserves every other parameter when toggled or cleared', () => {
    // A fresh URLSearchParams instance models the page's lazy initial state
    // when a user opens or hard-refreshes a saved /assets link.
    const restored = parseAssetPageFilters(new URLSearchParams(incomingQuery));
    expect(restored.neverScanned).toBe(true);
    expect(restored.scanRecency).toBe('noRecent30d');
    expect(restored.latestScanStatus).toBe('failed');
    expect(restored.alertPresence).toBe('with');
    expect(restored.sort).toBe('riskScore:asc');
    expect(restored.page).toBe(3);
    expect(restored.pageSize).toBe(20);

    const serialized = new URLSearchParams(buildAssetQueryString(incomingQuery, restored).slice(1));
    expect(serialized.get('neverScanned')).toBe('true');
    expect(serialized.get('latestScanStatus')).toBe('failed');
    expect(serialized.get('alertPresence')).toBe('with');
    expect(serialized.get('page')).toBe('3');
    expect(serialized.get('pageSize')).toBe('20');

    const clearedQuery = buildAssetQueryString(incomingQuery, {
      ...restored,
      neverScanned: false,
    });
    const cleared = new URLSearchParams(clearedQuery.slice(1));
    expect(cleared.has('neverScanned')).toBe(false);
    expect(cleared.get('q')).toBe('api.example.test');
    expect(cleared.get('severity')).toBe('high');
    expect(cleared.get('status')).toBe('open');
    expect(cleared.get('minRiskScore')).toBe('5');
    expect(cleared.get('scanRecency')).toBe('noRecent30d');
    expect(cleared.get('latestScanStatus')).toBe('failed');
    expect(cleared.get('riskTrend')).toBe('rising');
    expect(cleared.get('alertPresence')).toBe('with');
    expect(cleared.get('sort')).toBe('riskScore:asc');
    expect(cleared.get('page')).toBe('3');
    expect(cleared.get('pageSize')).toBe('20');
  });

  it('switches back to all assets without dropping search, sort, or pagination state', () => {
    const restored = parseAssetPageFilters(new URLSearchParams(incomingQuery));
    const allAssetsQuery = buildAssetQueryString(incomingQuery, {
      ...restored,
      alertPresence: 'all',
    });
    const allAssets = new URLSearchParams(allAssetsQuery.slice(1));

    expect(allAssets.has('alertPresence')).toBe(false);
    expect(allAssets.get('q')).toBe('api.example.test');
    expect(allAssets.get('sort')).toBe('riskScore:asc');
    expect(allAssets.get('page')).toBe('3');
    expect(allAssets.get('pageSize')).toBe('20');

    const unresolvedAgain = new URLSearchParams(
      buildAssetQueryString(allAssetsQuery.slice(1), { ...restored, alertPresence: 'with' }).slice(
        1,
      ),
    );
    expect(unresolvedAgain.get('alertPresence')).toBe('with');
    expect(unresolvedAgain.get('page')).toBe('3');
    expect(unresolvedAgain.get('pageSize')).toBe('20');
  });

  it('preserves active filters and page size while resetting to page one on a sort change', () => {
    const query =
      'q=api.example.test&severity=critical&status=resolved&minRiskScore=5&scanRecency=last7d&latestScanStatus=completed&neverScanned=true&riskTrend=rising&alertPresence=with&sort=latestScanAt&page=3&pageSize=20';
    const restored = parseAssetPageFilters(new URLSearchParams(query));
    const nextQuery = buildAssetQueryString(query, {
      ...restored,
      sort: 'latestScanAt:asc',
    });
    const requestState = new URLSearchParams(nextQuery.slice(1));

    expect(requestState.get('sort')).toBe('latestScanAt:asc');
    expect(requestState.get('q')).toBe('api.example.test');
    expect(requestState.get('severity')).toBe('critical');
    expect(requestState.get('status')).toBe('resolved');
    expect(requestState.get('minRiskScore')).toBe('5');
    expect(requestState.get('scanRecency')).toBe('last7d');
    expect(requestState.get('latestScanStatus')).toBe('completed');
    expect(requestState.get('neverScanned')).toBe('true');
    expect(requestState.get('riskTrend')).toBe('rising');
    expect(requestState.get('alertPresence')).toBe('with');
    expect(requestState.get('page')).toBe('1');
    expect(requestState.get('pageSize')).toBe('20');

    const reloaded = parseAssetPageFilters(requestState);
    expect(reloaded.sort).toBe('latestScanAt:asc');
    expect(reloaded.page).toBe(1);
    expect(reloaded.pageSize).toBe(20);
  });

  it('restores latest status on reload and retains it with every filter when paging', () => {
    const query =
      'q=api.example.test&severity=critical&status=resolved&minRiskScore=5&scanRecency=last7d&latestScanStatus=completed&neverScanned=true&riskTrend=rising&alertPresence=with&sort=name&page=1&pageSize=1';
    const reloaded = parseAssetPageFilters(new URLSearchParams(query));
    expect(reloaded.latestScanStatus).toBe('completed');

    const pageTwoQuery = buildAssetQueryString(query, { ...reloaded, page: 2 });
    const pageTwo = new URLSearchParams(pageTwoQuery.slice(1));
    expect(pageTwo.get('latestScanStatus')).toBe('completed');
    expect(pageTwo.get('q')).toBe('api.example.test');
    expect(pageTwo.get('severity')).toBe('critical');
    expect(pageTwo.get('status')).toBe('resolved');
    expect(pageTwo.get('minRiskScore')).toBe('5');
    expect(pageTwo.get('scanRecency')).toBe('last7d');
    expect(pageTwo.get('neverScanned')).toBe('true');
    expect(pageTwo.get('riskTrend')).toBe('rising');
    expect(pageTwo.get('alertPresence')).toBe('with');
    expect(pageTwo.get('sort')).toBe('name');
    expect(pageTwo.get('page')).toBe('2');
    expect(pageTwo.get('pageSize')).toBe('1');

    const requestUrl = `/api/assets${pageTwoQuery}`;
    expect(new URL(requestUrl, 'http://localhost').searchParams.get('latestScanStatus')).toBe(
      'completed',
    );

    const cleared = new URLSearchParams(
      buildAssetQueryString(pageTwoQuery.slice(1), {
        ...reloaded,
        page: 2,
        latestScanStatus: null,
      }).slice(1),
    );
    expect(cleared.has('latestScanStatus')).toBe(false);
    expect(cleared.get('page')).toBe('2');
    expect(cleared.get('q')).toBe('api.example.test');
  });
});
