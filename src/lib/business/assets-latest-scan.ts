// @polsia:user-owned — Shared latest-scan selection for inventory and CSV export.

export interface LatestAssetScan {
  id: string;
  startedAt: Date;
  status: string;
}

export interface WorkspaceAssetScanRow {
  host: string;
  scan: LatestAssetScan & { teamId: string | null };
}

export interface LatestAssetScanDetails {
  latestScanAt: string | null;
  latestScanStatus: string | null;
}

/** A selected status matches only the newest scan from the active workspace. */
export function matchesLatestAssetScanStatus(
  scan: LatestAssetScan | null | undefined,
  status: string | undefined,
): boolean {
  return status === undefined || scan?.status === status;
}

/** Keep the newest workspace scan per host, breaking equal timestamps by the greatest scan ID. */
export function recordLatestWorkspaceAssetScan(
  latestByHost: Map<string, LatestAssetScan>,
  row: WorkspaceAssetScanRow,
  workspaceId: string,
): boolean {
  if (row.scan.teamId !== workspaceId) return false;

  const current = latestByHost.get(row.host);
  if (
    current &&
    (row.scan.startedAt.getTime() < current.startedAt.getTime() ||
      (row.scan.startedAt.getTime() === current.startedAt.getTime() &&
        row.scan.id.localeCompare(current.id) <= 0))
  ) {
    return true;
  }

  latestByHost.set(row.host, {
    id: row.scan.id,
    startedAt: row.scan.startedAt,
    status: row.scan.status,
  });
  return true;
}

/** Serialize scan details using the same fields and values as the inventory API. */
export function serializeLatestAssetScan(
  scan: LatestAssetScan | null | undefined,
): LatestAssetScanDetails {
  return {
    latestScanAt: scan?.startedAt.toISOString() ?? null,
    latestScanStatus: scan?.status ?? null,
  };
}
