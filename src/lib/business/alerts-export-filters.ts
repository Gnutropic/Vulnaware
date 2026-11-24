// @polsia:user-owned — Maps the active /alerts URL filters to the CSV request.

export const ALERTS_EXPORT_FILTER_KEYS = [
  'resolution',
  'severity',
  'source',
  'triggeredBy',
  'status',
  'acknowledged',
  'assigneeReady',
  'hideSnoozed',
  'highRiskAssets',
  'q',
  'hostname',
  'asset',
  'from',
  'to',
  'since',
  'sort',
  'ownedByMe',
  'remediated',
  'snoozed',
] as const;

type AlertsExportFilterKey = (typeof ALERTS_EXPORT_FILTER_KEYS)[number];

export function buildAlertsExportFilters(
  search: string,
): Partial<Record<AlertsExportFilterKey, string>> {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const filters: Partial<Record<AlertsExportFilterKey, string>> = {};

  for (const key of ALERTS_EXPORT_FILTER_KEYS) {
    const value = params.get(key);
    if (value !== null) filters[key] = value;
  }

  return filters;
}
