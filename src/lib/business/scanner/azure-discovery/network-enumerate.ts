// @polsia:user-owned — Azure network-tier enumeration for the discovery fanout.
// Lists Virtual Networks + Network Security Groups across a single
// subscription via @azure/arm-network's NetworkManagementClient. Pure
// output — no @/lib/db. NSGs are tagged 'public' when any inbound rule
// opens to 0.0.0.0/0 or '*'; vNets themselves are tagged 'private' unless
// one of their subnets is exposed — we keep the vNet descriptor for the
// matcher's seed entries that fire on vNet shape alone (none today).

import 'server-only';
import type { NetworkManagementClient } from '@azure/arm-network';
import type { AzureAssetDraft } from '@/lib/business/scanner/azure-discovery/shared';

export interface AzureNetworkParams {
  /** Pre-built NetworkManagementClient from the orchestrator. */
  client: NetworkManagementClient;
  subscriptionId: string;
}

interface NsgSecurityRule {
  direction?: string | null;
  access?: string | null;
  protocol?: string | null;
  sourceAddressPrefix?: string | null;
  destinationAddressPrefix?: string | null;
  destinationPortRange?: string | null;
  sourcePortRange?: string | null;
}

interface NsgView {
  id?: string | null;
  name?: string | null;
  location?: string | null;
  properties?: {
    securityRules?: NsgSecurityRule[] | null;
    defaultSecurityRules?: NsgSecurityRule[] | null;
  } | null;
}

/**
 * Lists vNets AND NSGs in a single subscription. Both come back as the
 * same shape (an ARM resource), so we put them through one iteration
 * helper to keep the code DRY.
 */
export async function enumerateNetwork(params: AzureNetworkParams): Promise<AzureAssetDraft[]> {
  const out: AzureAssetDraft[] = [];

  // 1. Virtual networks.
  try {
    const vnetIter = params.client.virtualNetworks.listAll() as AsyncIterable<unknown>;
    for await (const v of vnetIter) {
      const vnet = v as { id?: string | null; name?: string | null; location?: string | null };
      if (!vnet.id || !vnet.name) continue;
      out.push({
        subscriptionId: params.subscriptionId,
        location: (vnet.location ?? '').toLowerCase(),
        resourceType: 'microsoft.network/virtualnetworks',
        resourceArn: vnet.id,
        resourceId: vnet.name,
        publicExposure: 'private',
        serviceHint: null,
      });
    }
  } catch {
    // continue — best-effort.
  }

  // 2. NSGs.
  try {
    const nsgIter = params.client.networkSecurityGroups.listAll() as AsyncIterable<unknown>;
    for await (const n of nsgIter) {
      const nsg = n as NsgView;
      if (!nsg.id || !nsg.name) continue;
      const exposure = nsgOpensToInternet(nsg) ? 'public' : 'private';
      out.push({
        subscriptionId: params.subscriptionId,
        location: (nsg.location ?? '').toLowerCase(),
        resourceType: 'microsoft.network/networksecuritygroups',
        resourceArn: nsg.id,
        resourceId: nsg.name,
        publicExposure: exposure,
        serviceHint: exposure === 'public' ? 'public-internet' : null,
      });
    }
  } catch {
    // continue
  }

  return out;
}

/**
 * True iff any inbound rule in an NSG's `securityRules` array opens to
 * 0.0.0.0/0, '*', or 'internet' on an Allow path. We deliberately skip
 * `defaultSecurityRules` because those are baseline rules Azure attaches
 * to every NSG (AllowVnetInBound, DenyAllInbound, etc.) — looking at
 * them would create false positives on every NSG.
 */
function nsgOpensToInternet(nsg: NsgView): boolean {
  for (const rule of nsg.properties?.securityRules ?? []) {
    if (!rule) continue;
    if (rule.direction !== 'Inbound') continue;
    if (rule.access !== 'Allow') continue;
    if (!isPublicSource(rule)) continue;
    return true;
  }
  return false;
}

function isPublicSource(rule: NsgSecurityRule): boolean {
  const src = rule.sourceAddressPrefix ?? '';
  return src === '0.0.0.0/0' || src === '*' || src === 'Internet' || src === 'internet';
}
