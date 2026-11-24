// @polsia:user-owned — GCP network-tier enumeration for the discovery fanout.
// Lists VPC networks + firewall rules in a single project via
// @google-cloud/compute's NetworksClient + FirewallsClient. Pure output —
// no @/lib/db.
//
// Publicness for firewall rules: any ingress rule with `0.0.0.0/0` (or
// `::/0`) in sourceRanges is exposed. We tag the firewall resource
// 'public' in that case so the matcher's seed entries fire. VPC networks
// themselves are tagged 'private' (the public surface is the firewall).

import 'server-only';
import type { FirewallsClient, NetworksClient } from '@google-cloud/compute';
import type { GcpAssetDraft } from '@/lib/business/scanner/gcp-discovery/shared';

export interface GcpNetworkParams {
  /** Pre-built NetworksClient. */
  networks: NetworksClient;
  /** Pre-built FirewallsClient. */
  firewalls: FirewallsClient;
  projectId: string;
}

interface FirewallView {
  name?: string | null;
  selfLink?: string | null;
  network?: string | null;
  direction?: string | null;
  sourceRanges?: string[] | null;
  allowed?: Array<{
    IPProtocol?: string | null;
    ports?: string[] | null;
  }> | null;
  disabled?: boolean | null;
}

interface NetworkView {
  name?: string | null;
  selfLink?: string | null;
  autoCreateSubnetworks?: boolean | null;
}

/**
 * Lists networks + firewalls in a single project. Networks are tagged
 * 'private' (the firewall posture is what matters for public exposure).
 * Firewalls are tagged 'public' when ANY single ingress rule opens to
 * 0.0.0.0/0 OR ::/0 — the project-wide posture for that rule's network.
 */
export async function enumerateNetwork(params: GcpNetworkParams): Promise<GcpAssetDraft[]> {
  const out: GcpAssetDraft[] = [];

  // 1. VPC networks.
  try {
    const iter = params.networks.listAsync({
      project: params.projectId,
    }) as AsyncIterable<NetworkView>;
    for await (const n of iter) {
      const name = n.name;
      const link = n.selfLink;
      if (!name || !link) continue;
      out.push({
        projectId: params.projectId,
        zone: 'global',
        resourceType: 'compute.googleapis.com/Network',
        resourceArn: link,
        resourceId: name,
        publicExposure: 'private',
        serviceHint: n.autoCreateSubnetworks ? 'auto-subnets=true' : null,
      });
    }
  } catch {
    // best-effort
  }

  // 2. Firewalls.
  try {
    const iter = params.firewalls.listAsync({
      project: params.projectId,
    }) as AsyncIterable<FirewallView>;
    for await (const f of iter) {
      const name = f.name;
      const link = f.selfLink;
      if (!name || !link) continue;
      if (f.disabled === true) {
        out.push({
          projectId: params.projectId,
          zone: 'global',
          resourceType: 'compute.googleapis.com/Firewall',
          resourceArn: link,
          resourceId: name,
          publicExposure: 'private',
          serviceHint: 'disabled',
        });
        continue;
      }
      const exposure = firewallExposesInternet(f) ? 'public' : 'private';
      out.push({
        projectId: params.projectId,
        zone: 'global',
        resourceType: 'compute.googleapis.com/Firewall',
        resourceArn: link,
        resourceId: name,
        publicExposure: exposure,
        serviceHint: exposure === 'public' ? 'public-internet' : null,
      });
    }
  } catch {
    // best-effort
  }

  return out;
}

function firewallExposesInternet(fw: FirewallView): boolean {
  if (fw.direction !== 'INGRESS') return false;
  for (const range of fw.sourceRanges ?? []) {
    if (range === '0.0.0.0/0' || range === '::/0') return true;
  }
  return false;
}
