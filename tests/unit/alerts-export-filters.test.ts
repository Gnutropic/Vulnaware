// @polsia:user-owned — Pins the /alerts CSV request filter contract.

import { describe, expect, it } from 'vitest';
import {
  ALERTS_EXPORT_FILTER_KEYS,
  buildAlertsExportFilters,
} from '@/lib/business/alerts-export-filters';

const activeFilters = {
  resolution: 'unresolved',
  severity: 'critical,high',
  source: 'kev',
  triggeredBy: 'scheduled',
  status: 'in_progress',
  acknowledged: 'false',
  assigneeReady: 'true',
  hideSnoozed: '1',
  highRiskAssets: '1',
  q: 'CVE-2026-90001',
  hostname: 'api.example.test',
  asset: 'api.example.test:443/tcp',
  from: '2026-10-01',
  to: '2026-10-31',
  since: '7d',
  sort: 'severity_asc',
  ownedByMe: '1',
  remediated: '1',
  snoozed: '1',
} as const;

describe('alerts CSV export filters', () => {
  it('forwards every active alert filter but not UI pagination or workspace scope params', () => {
    const params = new URLSearchParams({
      ...activeFilters,
      page: '3',
      pageSize: '20',
      selected: 'alert-1',
      teamId: 'forged-team',
      workspaceId: 'forged-workspace',
    });

    expect(buildAlertsExportFilters(`?${params.toString()}`)).toEqual(activeFilters);
    expect(Object.keys(activeFilters)).toEqual([...ALERTS_EXPORT_FILTER_KEYS]);
  });

  it('omits only severity after the last selected tier is cleared', () => {
    const { severity: _severity, ...otherwiseActiveFilters } = activeFilters;
    const params = new URLSearchParams(otherwiseActiveFilters);

    expect(buildAlertsExportFilters(params.toString())).toEqual(otherwiseActiveFilters);
  });
});
