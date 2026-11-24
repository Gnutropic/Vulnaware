// @polsia:user-owned — Azure VM enumeration for the discovery fanout. Lists
// VMs in a single subscription + location via ComputeManagementClient.
// Pure output — no DB. SDK client is injected so tests can mock it with a
// fake `virtualMachines.listAll()` paginator.

import 'server-only';
import type { ComputeManagementClient } from '@azure/arm-compute';
import type { AzureAssetDraft } from '@/lib/business/scanner/azure-discovery/shared';

export interface AzureComputeParams {
  subscriptionId: string;
  location: string;
  /**
   * Pre-built ComputeManagementClient. The orchestrator injects the real SDK
   * client; tests inject a stub with a `virtualMachines.listAll()` method that
   * yields fixture rows via async iteration.
   */
  client: ComputeManagementClient;
}

interface VmNic {
  id?: string | null;
  properties?: {
    publicIPAddress?: { id?: string | null } | null;
    ipConfigurations?: Array<{
      properties?: { publicIPAddress?: { id?: string | null } | null } | null;
    }> | null;
  } | null;
}

interface VmView {
  id?: string | null;
  name?: string | null;
  type?: string | null;
  location?: string | null;
  networkProfile?: { networkInterfaces?: VmNic[] | null } | null;
}

export async function enumerateVirtualMachines(
  params: AzureComputeParams,
): Promise<AzureAssetDraft[]> {
  const out: AzureAssetDraft[] = [];
  // The SDK's listAll is a PagedAsyncIterableIterator — cast to an async-
  // iterable of unknown so tests can iterate fixture rows without importing
  // the heavy SDK type.
  const iter = params.client.virtualMachines.listAll() as AsyncIterable<unknown>;
  for await (const v of iter) {
    const vm = v as VmView;
    if (!vm.id || !vm.name) continue;
    if (
      vm.location &&
      params.location &&
      vm.location.toLowerCase() !== params.location.toLowerCase()
    ) {
      continue;
    }
    const publicExposure = vmHasPublicIp(vm) ? 'public' : 'private';
    out.push({
      subscriptionId: params.subscriptionId,
      location: (vm.location ?? params.location).toLowerCase(),
      resourceType: 'microsoft.compute/virtualmachines',
      resourceArn: vm.id,
      resourceId: vm.name,
      publicExposure,
      serviceHint: vm.type ?? null,
    });
  }
  return out;
}

function vmHasPublicIp(vm: VmView): boolean {
  for (const nic of vm.networkProfile?.networkInterfaces ?? []) {
    if (nic.properties?.publicIPAddress) return true;
    for (const ip of nic.properties?.ipConfigurations ?? []) {
      if (ip.properties?.publicIPAddress) return true;
    }
  }
  return false;
}
