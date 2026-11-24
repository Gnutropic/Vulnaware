// @polsia:user-owned — GCP Compute Engine instance enumeration. Uses
// InstancesClient.aggregatedList. Pure output — no DB; SDK client injected.

import 'server-only';
import type { GcpAssetDraft } from '@/lib/business/scanner/gcp-discovery/shared';

export interface GcpComputeParams {
  projectId: string;
  zones: string[];
  /**
   * Pre-built InstancesClient (or stub). aggregatedList method yields an
   * AsyncIterable of [scopeKey, { instances?, ...rest }] tuples. Aggregated
   * list is preferred over per-zone list — one call covers every zone for a
   * project.
   */
  client: {
    aggregatedList?: (request: {
      project: string;
    }) => AsyncIterable<[string, AggregatedInstancesResponse]>;
  };
}

interface InstanceNic {
  accessConfigs?: Array<{ type?: string | null; name?: string | null }> | null;
}

interface InstanceView {
  id?: string | string | null | number | null;
  name?: string | null;
  machineType?: string | null;
  networkInterfaces?: InstanceNic[] | null;
}

interface AggregatedInstancesResponse {
  instances?: Record<string, InstanceView> | null;
}

export async function enumerateGceInstances(params: GcpComputeParams): Promise<GcpAssetDraft[]> {
  const out: GcpAssetDraft[] = [];
  if (!params.client.aggregatedList) return out;
  const iter = params.client.aggregatedList({ project: params.projectId });
  for await (const [scopeKey, response] of iter) {
    if (!response?.instances) continue;
    // scopeKey is 'zones/<zone>'. We skip 'regions/<region>' since GCE
    // instances live in zones.
    if (!scopeKey.startsWith('zones/')) continue;
    const zone = scopeKey.slice('zones/'.length);
    if (params.zones.length > 0 && !params.zones.includes(zone)) continue;
    for (const [resourcePath, inst] of Object.entries(response.instances)) {
      if (!inst.name) continue;
      const publicExposure = instHasPublicAccess(inst) ? 'public' : 'private';
      const projectId = instProjectIdFromArn(resourcePath) ?? params.projectId;
      out.push({
        projectId,
        zone,
        resourceType: 'compute.googleapis.com/Instance',
        resourceArn: resourcePath,
        resourceId: inst.name,
        publicExposure,
        serviceHint: inst.machineType ?? null,
      });
    }
  }
  return out;
}

function instHasPublicAccess(inst: InstanceView): boolean {
  for (const nic of inst.networkInterfaces ?? []) {
    for (const cfg of nic.accessConfigs ?? []) {
      if (cfg.type === 'ONE_TO_ONE_NAT') return true;
    }
  }
  return false;
}

function instProjectIdFromArn(resourcePath: string): string | null {
  const m = /^projects\/([^/]+)\/zones\/[^/]+\/instances\//.exec(resourcePath);
  return m?.[1] ?? null;
}
