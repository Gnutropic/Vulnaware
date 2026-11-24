// @polsia:user-owned — GCP Cloud SQL enumeration for the discovery fanout.
// Uses the @google-cloud/sql v1 SqlInstancesServiceClient to list every
// SQL instance in a project. Pure output — no @/lib/db. The Cloud SQL
// Admin API returns `IpAddresses` for each instance, so the public-ness
// is straightforward: any ipv4Address on the instance => 'public'.

import 'server-only';
import type { SqlInstancesServiceClient } from '@google-cloud/sql';
import type { GcpAssetDraft } from '@/lib/business/scanner/gcp-discovery/shared';

export interface GcpSqlParams {
  /** Pre-built SqlInstancesServiceClient from the orchestrator. */
  client: SqlInstancesServiceClient;
  projectId: string;
}

interface IpAddress {
  type?: string | null;
  ipAddress?: string | null;
}

interface DatabaseInstance {
  name?: string | null;
  selfLink?: string | null;
  region?: string | null;
  ipAddresses?: IpAddress[] | null;
  settings?: {
    ipConfiguration?: {
      ipv4Enabled?: boolean | null;
      privateNetwork?: string | null;
      authorizedNetworks?: Array<{ value?: string | null }> | null;
    } | null;
  } | null;
  databaseVersion?: string | null;
}

/**
 * Lists every Cloud SQL instance in a project. Public-ness:
 *   - 'public'  — the instance has a public (PRIMARY) ipv4 ipAddress, OR
 *     ipv4Enabled is true in ipConfiguration (= public IP allowed).
 *   - 'private' — ipv4Enabled=false AND no PUBLIC ipAddresses.
 *   - 'unknown' — neither flag is present (older instances default to
 *     public, so 'unknown' is rarely the right answer; we leave it for
 *     gcloud projects imported via Terraform where the IP config is
 *     unset).
 */
export async function enumerateCloudSql(params: GcpSqlParams): Promise<GcpAssetDraft[]> {
  const out: GcpAssetDraft[] = [];
  // Pagination via pageToken: list() returns the synchronous first page in
  // a `[response, request, metadata]` tuple (gax convention). We cast
  // the response to our DatabaseInstance collection shape (extracted from
  // the proto). Using `list` rather than `listAsync` here is intentional —
  // we want to drive the pageToken ourselves so we can cap the discover
  // run at a sane page count.
  let pageToken: string | undefined;
  do {
    const [response] = (await params.client.list({
      project: params.projectId,
      pageToken,
    })) as unknown as [InstancesListResponse | null | undefined];
    const items = response?.items ?? [];
    for (const inst of items) {
      const name = inst.name;
      const link = inst.selfLink;
      if (!name || !link) continue;
      const exposure = classifySqlExposure(inst);
      out.push({
        projectId: params.projectId,
        zone: inst.region ?? 'global',
        resourceType: 'sqladmin.googleapis.com/Instance',
        resourceArn: link,
        resourceId: name,
        publicExposure: exposure,
        serviceHint: inst.databaseVersion ? `version=${inst.databaseVersion}` : null,
      });
    }
    pageToken = response?.nextPageToken || undefined;
  } while (pageToken);
  return out;
}

interface InstancesListResponse {
  items?: DatabaseInstance[] | null;
  nextPageToken?: string | null;
}

function classifySqlExposure(inst: DatabaseInstance): 'public' | 'private' | 'unknown' {
  const ipc = inst.settings?.ipConfiguration;
  if (ipc?.ipv4Enabled === false) return 'private';
  if (ipc?.ipv4Enabled === true) return 'public';
  for (const addr of inst.ipAddresses ?? []) {
    if (addr.type === 'PRIMARY' && addr.ipAddress) return 'public';
    if (addr.type === 'OUTGOIP' && addr.ipAddress) return 'public';
  }
  return 'unknown';
}
