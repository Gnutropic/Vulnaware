// @polsia:user-owned — URL state helpers shared by the /assets page and its tests.

import {
  type AssetAlertPresence,
  AssetQuery,
  type AssetRiskTrend,
  type AssetScanRecency,
  type AssetScanStatus,
  type AssetSeverity,
  type AssetSortKey,
} from '@/lib/contracts/assets';

export type AssetPageFilters = {
  severity: AssetSeverity | null;
  status: 'open' | 'in_progress' | 'resolved' | null;
  minRiskScore: number | null;
  scanRecency: AssetScanRecency;
  latestScanStatus: AssetScanStatus | null;
  neverScanned: boolean;
  riskTrend: AssetRiskTrend | null;
  alertPresence: AssetAlertPresence;
  sort: AssetSortKey;
  page: number;
  pageSize: number;
};

const DEFAULT_FILTERS: AssetPageFilters = {
  severity: null,
  status: null,
  minRiskScore: null,
  scanRecency: 'all',
  latestScanStatus: null,
  neverScanned: false,
  riskTrend: null,
  alertPresence: 'all',
  sort: 'openCount',
  page: 1,
  pageSize: 50,
};

export function parseAssetPageFilters(params: URLSearchParams): AssetPageFilters {
  const parsed = AssetQuery.safeParse(Object.fromEntries(params.entries()));
  if (!parsed.success) return { ...DEFAULT_FILTERS };

  return {
    severity: parsed.data.severity ?? null,
    status: (parsed.data.status as AssetPageFilters['status']) ?? null,
    minRiskScore: parsed.data.minRiskScore ?? null,
    scanRecency: parsed.data.scanRecency,
    latestScanStatus: parsed.data.latestScanStatus ?? null,
    neverScanned: parsed.data.neverScanned,
    riskTrend: parsed.data.riskTrend ?? null,
    alertPresence: parsed.data.alertPresence,
    sort: parsed.data.sort,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
  };
}

export function buildAssetQueryString(currentQuery: string, filters: AssetPageFilters): string {
  const params = new URLSearchParams(currentQuery);
  const currentSort = params.get('sort') ?? DEFAULT_FILTERS.sort;
  // A changed ordering invalidates the old offset; keep the user's page size and filters.
  const page = currentSort === filters.sort ? filters.page : 1;
  if (filters.severity) params.set('severity', filters.severity);
  else params.delete('severity');
  if (filters.status) params.set('status', filters.status);
  else params.delete('status');
  if (filters.minRiskScore !== null) params.set('minRiskScore', String(filters.minRiskScore));
  else params.delete('minRiskScore');
  if (filters.scanRecency !== 'all') params.set('scanRecency', filters.scanRecency);
  else params.delete('scanRecency');
  if (filters.latestScanStatus) params.set('latestScanStatus', filters.latestScanStatus);
  else params.delete('latestScanStatus');
  if (filters.neverScanned) params.set('neverScanned', 'true');
  else params.delete('neverScanned');
  if (filters.riskTrend) params.set('riskTrend', filters.riskTrend);
  else params.delete('riskTrend');
  if (filters.alertPresence !== 'all') params.set('alertPresence', filters.alertPresence);
  else params.delete('alertPresence');
  // Keep an explicitly supplied `sort=openCount` in place. When the user
  // changes sort back to the default, write the default rather than
  // reconstructing the URL and dropping its other list parameters.
  if (filters.sort !== 'openCount' || params.has('sort')) {
    params.set('sort', filters.sort);
  }
  if (page > 1 || params.has('page')) params.set('page', String(page));
  else params.delete('page');
  if (filters.pageSize !== 50 || params.has('pageSize')) {
    params.set('pageSize', String(filters.pageSize));
  } else {
    params.delete('pageSize');
  }
  const search = params.toString();
  return search ? `?${search}` : '';
}

export function clearAssetQueryParameter(currentQuery: string, key: string): string {
  const params = new URLSearchParams(currentQuery);
  params.delete(key);
  const search = params.toString();
  return search ? `?${search}` : '';
}
