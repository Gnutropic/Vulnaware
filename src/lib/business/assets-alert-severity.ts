// @polsia:user-owned — Highest unresolved alert severity per host.

import type { AssetSeverity } from '@/lib/contracts/assets';

export const ASSET_UNRESOLVED_ALERT_STATUSES = ['open', 'in_progress'] as const;

const UNRESOLVED_STATUS_SET = new Set<string>(ASSET_UNRESOLVED_ALERT_STATUSES);
const SEVERITY_RANK: Record<AssetSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export interface AssetAlertSeverityCandidate {
  host: string | null | undefined;
  severity: string | null | undefined;
  status: string;
  teamId: string;
}

export function bucketAssetSeverity(value: string | null | undefined): AssetSeverity {
  const severity = (value ?? '').toLowerCase();
  if (severity === 'critical') return 'critical';
  if (severity === 'high') return 'high';
  if (severity === 'medium') return 'medium';
  return 'low';
}

export function highestUnresolvedSeverityByHost(
  candidates: readonly AssetAlertSeverityCandidate[],
  activeWorkspaceId: string,
): Map<string, AssetSeverity> {
  const highestByHost = new Map<string, AssetSeverity>();

  for (const candidate of candidates) {
    if (
      candidate.teamId !== activeWorkspaceId ||
      !UNRESOLVED_STATUS_SET.has(candidate.status) ||
      !candidate.host
    ) {
      continue;
    }

    const severity = bucketAssetSeverity(candidate.severity);
    const current = highestByHost.get(candidate.host);
    if (current === undefined || SEVERITY_RANK[severity] > SEVERITY_RANK[current]) {
      highestByHost.set(candidate.host, severity);
    }
  }

  return highestByHost;
}
